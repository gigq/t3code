import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";
import type * as acp from "@agentclientprotocol/sdk";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { createAcpClientConnection } from "../acp/AcpClient.ts";
import { startAcpProcess } from "../acp/AcpProcess.ts";
import { closeAcpSessionRuntime, makeAcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { hasLoadSessionCapability } from "../acp/AcpProtocol.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { ProviderReplayTranscript } from "../Services/ProviderReplayTranscript.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = "copilot" as const;

type TerminalHandle = {
  readonly id: string;
  readonly sessionId: string;
  readonly child: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  released: boolean;
  readonly exitPromise: Promise<void>;
};

type PendingApproval = {
  readonly toolCallId: string;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval";
  readonly promise: Promise<ProviderApprovalDecision>;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
  readonly options: ReadonlyArray<acp.PermissionOption>;
};

type PendingUserInput = {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly promise: Promise<ProviderUserInputAnswers>;
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
};

type ItemState = {
  readonly runtimeItemId: string;
  readonly itemType:
    | "user_message"
    | "assistant_message"
    | "reasoning"
    | "plan"
    | "command_execution"
    | "file_change"
    | "web_search"
    | "dynamic_tool_call";
  completed: boolean;
};

type CopilotSessionContext = {
  session: ProviderSession;
  readonly child: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  cwd: string;
  runtimeMode: ProviderSession["runtimeMode"];
  model: string;
  activeTurnId: TurnId | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly terminals: Map<string, TerminalHandle>;
  readonly openItems: Map<string, ItemState>;
  readonly snapshotTurns: Array<{ id: TurnId; items: Array<unknown> }>;
  loadingHistory: boolean;
  replaying: boolean;
  turnCounter: number;
};

export function getCopilotChunkItemKey(input: {
  readonly turnId: TurnId;
  readonly updateType: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
  readonly messageId?: string | null | undefined;
}): string {
  const messageId = input.messageId?.trim();
  return messageId && messageId.length > 0 ? messageId : `${input.turnId}:${input.updateType}`;
}

export interface CopilotAdapterLiveOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTurnId(prefix: string): TurnId {
  return TurnId.makeUnsafe(`${prefix}-${randomUUID()}`);
}

function makeEventBase(
  context: CopilotSessionContext,
  input: {
    readonly type: ProviderRuntimeEvent["type"];
    readonly turnId?: TurnId;
    readonly itemId?: string;
    readonly requestId?: ApprovalRequestId;
    readonly raw?: ProviderRuntimeEvent["raw"];
    readonly payload: ProviderRuntimeEvent["payload"];
  },
): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: context.session.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
    type: input.type,
    payload: input.payload,
  } as ProviderRuntimeEvent;
}

function toRequestType(kind: acp.ToolKind | undefined): PendingApproval["requestType"] {
  switch (kind) {
    case "read":
    case "search":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "command_execution_approval";
  }
}

function toItemType(kind: acp.ToolKind | undefined): ItemState["itemType"] {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "fetch":
      return "web_search";
    case "search":
      return "web_search";
    case "think":
      return "reasoning";
    case "execute":
      return "command_execution";
    default:
      return "dynamic_tool_call";
  }
}

function assertContext(
  contexts: Map<ThreadId, CopilotSessionContext>,
  threadId: ThreadId,
): CopilotSessionContext {
  const context = contexts.get(threadId);
  if (!context) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  return context;
}

function ensureAllowedPath(root: string, absolutePath: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absolutePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${absolutePath}' is outside the Copilot session workspace.`);
  }
}

function choosePermissionOption(
  options: ReadonlyArray<acp.PermissionOption>,
  decision: ProviderApprovalDecision,
): acp.PermissionOption | undefined {
  const preferredKinds =
    decision === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision === "accept"
        ? ["allow_once", "allow_always"]
        : decision === "decline"
          ? ["reject_once", "reject_always"]
          : [];

  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function buildPromptBlocks(
  input: ProviderSendTurnInput,
  attachmentBytesById: ReadonlyMap<string, Uint8Array>,
): ReadonlyArray<acp.ContentBlock> {
  const prompt: acp.ContentBlock[] = [];
  if (typeof input.input === "string" && input.input.trim().length > 0) {
    prompt.push({
      type: "text",
      text: input.input,
    });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }
    const bytes = attachmentBytesById.get(attachment.id);
    if (!bytes) {
      continue;
    }
    prompt.push({
      type: "image",
      mimeType: attachment.mimeType,
      data: Buffer.from(bytes).toString("base64"),
      uri: `attachment:${attachment.id}`,
    });
  }

  return prompt;
}

function updateSnapshot(context: CopilotSessionContext, turnId: TurnId, item: unknown): void {
  const existing = context.snapshotTurns.find((candidate) => candidate.id === turnId);
  if (existing) {
    existing.items.push(item);
    return;
  }
  context.snapshotTurns.push({
    id: turnId,
    items: [item],
  });
}

function updateSession(context: CopilotSessionContext, patch: Partial<ProviderSession>): void {
  context.session = {
    ...context.session,
    ...patch,
  };
}

function currentTurnId(context: CopilotSessionContext): TurnId {
  if (!context.activeTurnId) {
    context.activeTurnId = makeTurnId("copilot-turn");
  }
  return context.activeTurnId;
}

function buildTerminalHandle(input: {
  sessionId: string;
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  outputByteLimit?: number | null;
}): TerminalHandle {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const outputByteLimit = input.outputByteLimit ?? 256_000;
  let output = "";
  let truncated = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;

  const append = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    output += text;
    if (Buffer.byteLength(output, "utf8") > outputByteLimit) {
      const bytes = Buffer.from(output, "utf8");
      output = bytes.subarray(bytes.length - outputByteLimit).toString("utf8");
      truncated = true;
    }
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const exitPromise = new Promise<void>((resolve) => {
    child.once("close", (code, nextSignal) => {
      exitCode = code;
      signal = nextSignal;
      resolve();
    });
  });

  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    child,
    output,
    truncated,
    exitCode,
    signal,
    released: false,
    exitPromise,
  };
}

const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  _options?: CopilotAdapterLiveOptions,
) {
  const settings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const replayTranscript = yield* ProviderReplayTranscript;
  const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const contexts = new Map<ThreadId, CopilotSessionContext>();
  const services = yield* Effect.services();
  const runFork = Effect.runForkWith(services);
  const runPromise = Effect.runPromiseWith(services);

  const getCopilotSettings = (operation: string) =>
    settings.getSettings.pipe(
      Effect.map((nextSettings) => nextSettings.providers.copilot),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: cause instanceof Error ? cause.message : "Failed to read Copilot settings.",
            cause,
          }),
      ),
    );

  const publish = (event: ProviderRuntimeEvent) => {
    runFork(Queue.offer(eventQueue, event));
  };

  const closeContext = async (context: CopilotSessionContext): Promise<void> => {
    for (const terminal of context.terminals.values()) {
      if (!terminal.released) {
        terminal.child.kill("SIGTERM");
      }
    }
    await runPromise(closeAcpSessionRuntime({ child: context.child }));
  };

  const handleSessionUpdate = (
    context: CopilotSessionContext,
    notification: acp.SessionNotification,
  ) => {
    const turnId = currentTurnId(context);
    const raw = {
      source: "copilot.acp.notification" as const,
      method: "session/update",
      payload: notification,
    };
    const publishIfVisible = (event: ProviderRuntimeEvent) => {
      if (!context.loadingHistory && !context.replaying) {
        publish(event);
      }
    };

    switch (notification.update.sessionUpdate) {
      case "session_info_update": {
        if (notification.update.title) {
          publishIfVisible(
            makeEventBase(context, {
              type: "thread.metadata.updated",
              turnId,
              raw,
              payload: {
                name: notification.update.title,
              },
            }),
          );
        }
        return;
      }
      case "usage_update": {
        const usage: ThreadTokenUsageSnapshot = {
          usedTokens: Math.max(0, notification.update.used),
          maxTokens: Math.max(1, notification.update.size),
        };
        publishIfVisible(
          makeEventBase(context, {
            type: "thread.token-usage.updated",
            turnId,
            raw,
            payload: { usage },
          }),
        );
        return;
      }
      case "plan": {
        publishIfVisible(
          makeEventBase(context, {
            type: "turn.plan.updated",
            turnId,
            raw,
            payload: {
              plan: notification.update.entries.map((entry) => ({
                step: entry.content,
                status:
                  entry.status === "in_progress"
                    ? "inProgress"
                    : entry.status === "completed"
                      ? "completed"
                      : "pending",
              })),
            },
          }),
        );
        updateSnapshot(context, turnId, notification.update);
        return;
      }
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "user_message_chunk": {
        const messageId = getCopilotChunkItemKey({
          turnId,
          updateType: notification.update.sessionUpdate,
          messageId: notification.update.messageId,
        });
        const existing = context.openItems.get(messageId);
        const itemType =
          notification.update.sessionUpdate === "agent_thought_chunk"
            ? "reasoning"
            : notification.update.sessionUpdate === "user_message_chunk"
              ? "user_message"
              : "assistant_message";
        const runtimeItemId = existing?.runtimeItemId ?? `copilot-item-${messageId}`;

        if (!existing) {
          context.openItems.set(messageId, {
            runtimeItemId,
            itemType,
            completed: false,
          });
          publishIfVisible(
            makeEventBase(context, {
              type: "item.started",
              turnId,
              itemId: runtimeItemId,
              raw,
              payload: {
                itemType,
                title:
                  itemType === "assistant_message"
                    ? "Assistant message"
                    : itemType === "reasoning"
                      ? "Reasoning"
                      : "User message",
              },
            }),
          );
        }

        const text =
          notification.update.content.type === "text"
            ? notification.update.content.text
            : `[${notification.update.content.type}]`;
        publishIfVisible(
          makeEventBase(context, {
            type: "content.delta",
            turnId,
            itemId: runtimeItemId,
            raw,
            payload: {
              streamKind: itemType === "reasoning" ? "reasoning_text" : "assistant_text",
              delta: text,
            },
          }),
        );
        updateSnapshot(context, turnId, notification.update);
        return;
      }
      case "tool_call": {
        const runtimeItemId = `copilot-tool-${notification.update.toolCallId}`;
        context.openItems.set(notification.update.toolCallId, {
          runtimeItemId,
          itemType: toItemType(notification.update.kind),
          completed: false,
        });
        publishIfVisible(
          makeEventBase(context, {
            type: "item.started",
            turnId,
            itemId: runtimeItemId,
            raw,
            payload: {
              itemType: toItemType(notification.update.kind),
              status: notification.update.status === "failed" ? "failed" : "inProgress",
              title: notification.update.title,
              data: notification.update,
            },
          }),
        );
        updateSnapshot(context, turnId, notification.update);
        return;
      }
      case "tool_call_update": {
        const existing = context.openItems.get(notification.update.toolCallId);
        const runtimeItemId =
          existing?.runtimeItemId ?? `copilot-tool-${notification.update.toolCallId}`;
        const itemType = existing?.itemType ?? toItemType(notification.update.kind ?? undefined);
        publishIfVisible(
          makeEventBase(context, {
            type: "item.updated",
            turnId,
            itemId: runtimeItemId,
            raw,
            payload: {
              itemType,
              status:
                notification.update.status === "completed"
                  ? "completed"
                  : notification.update.status === "failed"
                    ? "failed"
                    : "inProgress",
              title: notification.update.title ?? undefined,
              data: notification.update,
            },
          }),
        );

        for (const content of notification.update.content ?? []) {
          if (content.type === "content" && content.content.type === "text") {
            publishIfVisible(
              makeEventBase(context, {
                type: "content.delta",
                turnId,
                itemId: runtimeItemId,
                raw,
                payload: {
                  streamKind: itemType === "file_change" ? "file_change_output" : "command_output",
                  delta: content.content.text,
                },
              }),
            );
          }
        }

        if (notification.update.status === "completed" || notification.update.status === "failed") {
          publishIfVisible(
            makeEventBase(context, {
              type: "item.completed",
              turnId,
              itemId: runtimeItemId,
              raw,
              payload: {
                itemType,
                status: notification.update.status === "failed" ? "failed" : "completed",
                title: notification.update.title ?? undefined,
                data: notification.update,
              },
            }),
          );
          context.openItems.delete(notification.update.toolCallId);
        }
        updateSnapshot(context, turnId, notification.update);
        return;
      }
      default:
        updateSnapshot(context, turnId, notification.update);
    }
  };

  const makeClient = (context: CopilotSessionContext): acp.Client => ({
    async sessionUpdate(params) {
      handleSessionUpdate(context, params);
    },
    async requestPermission(params) {
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const requestType = toRequestType(params.toolCall.kind ?? undefined);
      const activeTurnId = context.activeTurnId;

      if (context.runtimeMode === "full-access" || context.replaying) {
        const selected =
          choosePermissionOption(params.options, "acceptForSession") ??
          choosePermissionOption(params.options, "accept");
        publish(
          makeEventBase(context, {
            type: "request.resolved",
            ...(activeTurnId ? { turnId: activeTurnId } : {}),
            requestId,
            raw: {
              source: "copilot.acp.request",
              method: "session/request_permission",
              payload: params,
            },
            payload: {
              requestType,
              decision: selected ? "acceptForSession" : "cancel",
            },
          }),
        );
        return selected
          ? { outcome: { outcome: "selected", optionId: selected.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }

      let resolveDecision!: (decision: ProviderApprovalDecision) => void;
      const decisionPromise = new Promise<ProviderApprovalDecision>((resolve) => {
        resolveDecision = resolve;
      });
      context.pendingApprovals.set(requestId, {
        toolCallId: params.toolCall.toolCallId,
        requestType,
        promise: decisionPromise,
        resolve: resolveDecision,
        options: params.options,
      });

      publish(
        makeEventBase(context, {
          type: "request.opened",
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          requestId,
          raw: {
            source: "copilot.acp.request",
            method: "session/request_permission",
            payload: params,
          },
          payload: {
            requestType,
            detail: params.toolCall.title,
            args: params.toolCall.rawInput,
          },
        }),
      );

      const resolvedDecision = await decisionPromise;
      context.pendingApprovals.delete(requestId);
      const selected = choosePermissionOption(params.options, resolvedDecision);
      publish(
        makeEventBase(context, {
          type: "request.resolved",
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          requestId,
          raw: {
            source: "copilot.acp.request",
            method: "session/request_permission",
            payload: params,
          },
          payload: {
            requestType,
            decision: resolvedDecision,
            resolution: selected ? { optionId: selected.optionId } : undefined,
          },
        }),
      );
      return selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async readTextFile(params) {
      ensureAllowedPath(context.cwd, params.path);
      const absolutePath = path.resolve(params.path);
      const contents = await runPromise(fileSystem.readFileString(absolutePath));
      if (!params.line || params.line <= 1) {
        if (!params.limit || params.limit <= 0) {
          return { content: contents };
        }
        return {
          content: contents.split(/\r?\n/).slice(0, params.limit).join("\n"),
        };
      }
      const lines = contents.split(/\r?\n/);
      const start = Math.max(0, params.line - 1);
      const end = params.limit && params.limit > 0 ? start + params.limit : undefined;
      return { content: lines.slice(start, end).join("\n") };
    },
    async writeTextFile(params) {
      ensureAllowedPath(context.cwd, params.path);
      const absolutePath = path.resolve(params.path);
      await runPromise(fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true }));
      await runPromise(fileSystem.writeFileString(absolutePath, params.content));
      return {};
    },
    async createTerminal(params) {
      ensureAllowedPath(context.cwd, params.cwd ?? context.cwd);
      const terminal = buildTerminalHandle({
        sessionId: params.sessionId,
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd ?? context.cwd,
        ...(params.env
          ? {
              env: params.env.reduce<NodeJS.ProcessEnv>(
                (acc, variable) => {
                  acc[variable.name] = variable.value;
                  return acc;
                },
                { ...process.env },
              ),
            }
          : {}),
        ...(params.outputByteLimit !== undefined
          ? { outputByteLimit: params.outputByteLimit }
          : {}),
      });
      context.terminals.set(terminal.id, terminal);
      return { terminalId: terminal.id };
    },
    async terminalOutput(params) {
      const terminal = context.terminals.get(params.terminalId);
      if (!terminal) {
        throw new Error(`Unknown terminal '${params.terminalId}'.`);
      }
      return {
        output: terminal.output,
        truncated: terminal.truncated,
        ...(terminal.exitCode !== null || terminal.signal !== null
          ? {
              exitStatus: {
                exitCode: terminal.exitCode,
                signal: terminal.signal,
              },
            }
          : {}),
      };
    },
    async waitForTerminalExit(params) {
      const terminal = context.terminals.get(params.terminalId);
      if (!terminal) {
        throw new Error(`Unknown terminal '${params.terminalId}'.`);
      }
      await terminal.exitPromise;
      return {
        exitCode: terminal.exitCode,
        signal: terminal.signal ?? null,
      };
    },
    async killTerminal(params) {
      const terminal = context.terminals.get(params.terminalId);
      if (!terminal) {
        throw new Error(`Unknown terminal '${params.terminalId}'.`);
      }
      terminal.child.kill("SIGTERM");
      return {};
    },
    async releaseTerminal(params) {
      const terminal = context.terminals.get(params.terminalId);
      if (!terminal) {
        return {};
      }
      terminal.released = true;
      terminal.child.kill("SIGTERM");
      context.terminals.delete(params.terminalId);
      return {};
    },
  });

  const openContext = Effect.fn("CopilotAdapter.openContext")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly runtimeMode: ProviderSession["runtimeMode"];
    readonly model: string;
    readonly resumeCursor?: unknown;
  }) {
    const providerSettings = yield* getCopilotSettings("openContext");
    const acpArgs = [
      "--acp",
      "--stdio",
      "--no-color",
      ...(input.runtimeMode === "full-access" ? ["--allow-all"] : []),
      ...(input.model !== "default" ? ["--model", input.model] : []),
    ];
    const processHandle = yield* startAcpProcess({
      binaryPath: providerSettings.binaryPath,
      args: acpArgs,
      cwd: input.cwd,
      env: process.env,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause.message,
            cause,
          }),
      ),
    );

    const session: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd: input.cwd,
      model: input.model,
      threadId: input.threadId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const context: CopilotSessionContext = {
      session,
      child: processHandle.child,
      connection: undefined as unknown as acp.ClientSideConnection,
      sessionId: "",
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      model: input.model,
      activeTurnId: undefined,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      terminals: new Map(),
      openItems: new Map(),
      snapshotTurns: [],
      loadingHistory: false,
      replaying: false,
      turnCounter: 0,
    };

    const initialized = yield* createAcpClientConnection({
      client: makeClient(context),
      stream: processHandle.stream,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const runtime = makeAcpSessionRuntime(initialized);
    context.connection = runtime.connection;

    const resumeCursor =
      input.resumeCursor && typeof input.resumeCursor === "object"
        ? (input.resumeCursor as { sessionId?: string })
        : undefined;
    const resumeSessionId =
      typeof resumeCursor?.sessionId === "string" ? resumeCursor.sessionId : null;

    if (resumeSessionId && hasLoadSessionCapability(runtime.initialize.agentCapabilities)) {
      context.loadingHistory = true;
      yield* Effect.tryPromise({
        try: () =>
          runtime.connection.loadSession({
            sessionId: resumeSessionId,
            cwd: input.cwd,
            mcpServers: [],
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            context.sessionId = resumeSessionId;
            context.loadingHistory = false;
            updateSession(context, { resumeCursor: { sessionId: resumeSessionId } });
          }),
        ),
      );
    } else {
      const created = yield* Effect.tryPromise({
        try: () =>
          runtime.connection.newSession({
            cwd: input.cwd,
            mcpServers: [],
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      context.sessionId = created.sessionId;
      updateSession(context, { resumeCursor: { sessionId: created.sessionId } });
    }

    contexts.set(input.threadId, context);
    publish(
      makeEventBase(context, {
        type: "session.started",
        payload: {
          resume: context.session.resumeCursor,
        },
      }),
    );
    publish(
      makeEventBase(context, {
        type: "thread.started",
        payload: {
          providerThreadId: context.sessionId,
        },
      }),
    );
    publish(
      makeEventBase(context, {
        type: "session.state.changed",
        payload: {
          state: "ready",
        },
      }),
    );

    return context;
  });

  const ensureModel = Effect.fn("CopilotAdapter.ensureModel")(function* (
    context: CopilotSessionContext,
    requestedModel: string,
  ) {
    if (requestedModel === context.model) {
      return context;
    }
    const resumeCursor = context.session.resumeCursor;
    yield* Effect.tryPromise({
      try: () => closeContext(context),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    contexts.delete(context.session.threadId);
    return yield* openContext({
      threadId: context.session.threadId,
      cwd: context.cwd,
      runtimeMode: context.runtimeMode,
      model: requestedModel,
      resumeCursor,
    });
  });

  const resolveAttachmentBytes = Effect.fn("CopilotAdapter.resolveAttachmentBytes")(function* (
    input: ProviderSendTurnInput,
  ) {
    const attachmentBytes = new Map<string, Uint8Array>();
    for (const attachment of input.attachments ?? []) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: cause instanceof Error ? cause.message : "Failed to read attachment.",
              cause,
            }),
        ),
      );
      attachmentBytes.set(attachment.id, bytes);
    }
    return attachmentBytes;
  });

  const promptInSession = Effect.fn("CopilotAdapter.promptInSession")(function* (input: {
    readonly context: CopilotSessionContext;
    readonly prompt: ReadonlyArray<acp.ContentBlock>;
    readonly turnId: TurnId;
    readonly visible: boolean;
  }) {
    const { context, turnId } = input;
    context.activeTurnId = turnId;
    context.openItems.clear();
    if (input.visible) {
      publish(
        makeEventBase(context, {
          type: "turn.started",
          turnId,
          payload: {
            model: context.model,
          },
        }),
      );
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        context.connection.prompt({
          sessionId: context.sessionId,
          prompt: [...input.prompt],
          messageId: randomUUID(),
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/prompt",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    for (const item of context.openItems.values()) {
      if (item.completed) {
        continue;
      }
      if (input.visible) {
        publish(
          makeEventBase(context, {
            type: "item.completed",
            turnId,
            itemId: item.runtimeItemId,
            payload: {
              itemType: item.itemType,
              status: "completed",
            },
          }),
        );
      }
    }
    context.openItems.clear();

    if (input.visible) {
      if (result.stopReason === "cancelled") {
        publish(
          makeEventBase(context, {
            type: "turn.aborted",
            turnId,
            payload: {
              reason: "cancelled",
            },
          }),
        );
      } else {
        publish(
          makeEventBase(context, {
            type: "turn.completed",
            turnId,
            payload: {
              state:
                result.stopReason === "end_turn"
                  ? "completed"
                  : result.stopReason === "refusal"
                    ? "failed"
                    : "completed",
              stopReason: result.stopReason,
              usage: result.usage ?? undefined,
            },
          }),
        );
      }
    }

    context.activeTurnId = undefined;
    updateSession(context, {
      activeTurnId: undefined,
      updatedAt: nowIso(),
    });
    return result;
  });

  const replayTranscriptIntoSession = Effect.fn("CopilotAdapter.replayTranscriptIntoSession")(
    function* (
      context: CopilotSessionContext,
      turns: ReadonlyArray<{ text: string; attachments: ReadonlyArray<any> }>,
    ) {
      context.replaying = true;
      for (const turn of turns) {
        if (turn.text.trim().length === 0 && turn.attachments.length === 0) {
          continue;
        }
        const attachmentBytes = new Map<string, Uint8Array>();
        for (const attachment of turn.attachments) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            continue;
          }
          const bytes = yield* fileSystem
            .readFile(attachmentPath)
            .pipe(Effect.orElseSucceed(() => new Uint8Array()));
          attachmentBytes.set(attachment.id, bytes);
        }
        yield* promptInSession({
          context,
          prompt: buildPromptBlocks(
            {
              threadId: context.session.threadId,
              input: turn.text,
              attachments: turn.attachments,
            } as ProviderSendTurnInput,
            attachmentBytes,
          ),
          turnId: makeTurnId("copilot-replay"),
          visible: false,
        });
      }
      context.replaying = false;
    },
  );

  const startSession: CopilotAdapterShape["startSession"] = Effect.fn(
    "CopilotAdapter.startSession",
  )(function* (input) {
    const copilotSettings = yield* getCopilotSettings("startSession");
    if (!copilotSettings.enabled) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "Copilot provider is disabled.",
      });
    }

    const model =
      input.modelSelection?.provider === "copilot" ? input.modelSelection.model : "default";
    const context = yield* openContext({
      threadId: input.threadId,
      cwd: input.cwd ?? process.cwd(),
      runtimeMode: input.runtimeMode,
      model,
      resumeCursor: input.resumeCursor,
    });
    return context.session;
  });

  const sendTurn: CopilotAdapterShape["sendTurn"] = Effect.fn("CopilotAdapter.sendTurn")(
    function* (input) {
      let context = assertContext(contexts, input.threadId);
      const requestedModel =
        input.modelSelection?.provider === "copilot" ? input.modelSelection.model : context.model;
      context = yield* ensureModel(context, requestedModel);
      const attachmentBytes = yield* resolveAttachmentBytes(input);
      const turnId = makeTurnId("copilot-turn");
      yield* promptInSession({
        context,
        prompt: buildPromptBlocks(input, attachmentBytes),
        turnId,
        visible: true,
      });
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: {
          sessionId: context.sessionId,
        },
      };
    },
  );

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.tryPromise({
      try: async () => {
        const context = assertContext(contexts, threadId);
        if (!context.activeTurnId) {
          return;
        }
        await context.connection.cancel({ sessionId: context.sessionId });
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/cancel",
          detail: cause instanceof Error ? cause.message : "Failed to cancel Copilot turn.",
          cause,
        }),
    });

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.sync(() => {
      const context = assertContext(contexts, threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "request/respond",
          detail: `Unknown pending approval request '${requestId}'.`,
        });
      }
      pending.resolve(decision);
    });

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.sync(() => {
      const context = assertContext(contexts, threadId);
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "user-input/respond",
          detail: `Unknown pending user-input request '${requestId}'.`,
        });
      }
      pending.resolve(answers);
    });

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.tryPromise({
      try: async () => {
        const context = assertContext(contexts, threadId);
        contexts.delete(threadId);
        await closeContext(context);
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: cause instanceof Error ? cause.message : "Failed to stop Copilot session.",
          cause,
        }),
    });

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.succeed(Array.from(contexts.values(), (context) => context.session));

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(contexts.has(threadId));

  const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => {
      const context = assertContext(contexts, threadId);
      return {
        threadId,
        turns: context.snapshotTurns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      } satisfies ProviderThreadSnapshot;
    });

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = Effect.fn(
    "CopilotAdapter.rollbackThread",
  )(function* (threadId, numTurns) {
    const current = assertContext(contexts, threadId);
    const transcript = yield* replayTranscript.readTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: cause instanceof Error ? cause.message : "Failed to read replay transcript.",
            cause,
          }),
      ),
    );
    const keptUserTurns = transcript.turns
      .filter((turn) => turn.role === "user")
      .slice(
        0,
        Math.max(0, transcript.turns.filter((turn) => turn.role === "user").length - numTurns),
      );

    yield* stopSession(threadId);
    const rebuilt = yield* openContext({
      threadId,
      cwd: transcript.cwd,
      runtimeMode: current.runtimeMode,
      model: current.model,
    });
    yield* replayTranscriptIntoSession(rebuilt, keptUserTurns);
    return {
      threadId,
      turns: rebuilt.snapshotTurns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    } satisfies ProviderThreadSnapshot;
  });

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.tryPromise({
      try: async () => {
        await Promise.all(Array.from(contexts.values(), (context) => closeContext(context)));
        contexts.clear();
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: ThreadId.makeUnsafe("all"),
          detail: cause instanceof Error ? cause.message : "Failed to stop Copilot sessions.",
          cause,
        }),
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(eventQueue),
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());
