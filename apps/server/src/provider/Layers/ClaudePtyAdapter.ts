import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { shellQuote } from "../../workspace/RemoteShell.ts";
import { PtyAdapter, type PtyProcess } from "../../terminal/Services/PTY.ts";
import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudePtyAdapter, type ClaudePtyAdapterShape } from "../Services/ClaudePtyAdapter.ts";
import { chunkPtyDelta } from "../ptyTerminalText.ts";

const PROVIDER = "claudePty" as const;
const REMOTE_CLAUDE_PATH_SETUP =
  'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"';
const TURN_IDLE_COMPLETE_MS = 2_500;
const TURN_NO_OUTPUT_WARNING_MS = 30_000;
const TURN_HARD_TIMEOUT_MS = 20 * 60 * 1_000;
const TRANSCRIPT_POLL_MS = 1_000;
const INPUT_READY_DELAY_MS = 2_500;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const execFileAsync = promisify(execFile);

interface ClaudePtyResumeState {
  readonly kind?: "claudePty";
  readonly sessionId?: string;
}

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly itemId: RuntimeItemId;
  emittedLength: number;
  outputText: string;
  seenAssistantUuids: ReadonlySet<string>;
  sawOutput: boolean;
  completed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  noOutputTimer: ReturnType<typeof setTimeout> | undefined;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
}

interface ClaudePtySessionContext {
  session: ProviderSession;
  readonly pty: PtyProcess;
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectLocation: ProviderSessionStartInput["projectLocation"] | undefined;
  readonly inputReadyAtMs: number;
  activeTurn: ActiveTurnState | undefined;
  stopped: boolean;
  readonly removeDataListener: () => void;
  readonly removeExitListener: () => void;
}

export interface ClaudePtyLaunch {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventId(): EventId {
  return EventId.makeUnsafe(randomUUID());
}

function turnId(): TurnId {
  return TurnId.makeUnsafe(randomUUID());
}

function itemId(): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(randomUUID());
}

function readResumeState(value: unknown): ClaudePtyResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    ...(record.kind === "claudePty" ? { kind: "claudePty" as const } : {}),
    ...(typeof record.sessionId === "string" && record.sessionId.trim().length > 0
      ? { sessionId: record.sessionId }
      : {}),
  };
}

function claudePtyResumeCursor(sessionId: string): ClaudePtyResumeState {
  return { kind: "claudePty", sessionId };
}

function runtimePermissionMode(input: ProviderSessionStartInput): "bypassPermissions" | "default" {
  return input.runtimeMode === "full-access" ? "bypassPermissions" : "default";
}

export function buildClaudeArgs(input: {
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
  readonly sessionId: string;
  readonly resume: boolean;
  readonly threadId: ThreadId;
}): string[] {
  const args = [
    input.resume ? "--resume" : "--session-id",
    input.sessionId,
    "--name",
    `T3 ${input.threadId.slice(0, 8)}`,
  ];
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  const permissionMode = input.runtimeMode === "full-access" ? "bypassPermissions" : "default";
  args.push("--permission-mode", permissionMode);
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

export function buildClaudePtyLaunch(input: {
  readonly binaryPath: string;
  readonly cwd: string | undefined;
  readonly projectLocation: ProviderSessionStartInput["projectLocation"] | undefined;
  readonly args: ReadonlyArray<string>;
}): ClaudePtyLaunch {
  const sshProject = input.projectLocation?.kind === "ssh" ? input.projectLocation : undefined;
  if (!sshProject) {
    return {
      shell: input.binaryPath,
      args: [...input.args],
      cwd: input.cwd ?? process.cwd(),
    };
  }

  const remoteScript = `${REMOTE_CLAUDE_PATH_SETUP}; cd ${shellQuote(
    sshProject.remotePath,
  )} && exec claude "$@"`;
  const remoteCommand = [
    "exec",
    "/bin/sh",
    "-lc",
    shellQuote(remoteScript),
    "--",
    ...input.args.map(shellQuote),
  ].join(" ");
  return {
    shell: "ssh",
    args: [
      "-tt",
      ...(sshProject.port !== undefined ? ["-p", String(sshProject.port)] : []),
      sshProject.host,
      remoteCommand,
    ],
    cwd: process.cwd(),
  };
}

function bestEffortAnswerText(answers: ProviderUserInputAnswers): string {
  return Object.values(answers)
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value))
        return value.filter((entry): entry is string => typeof entry === "string");
      if (
        value &&
        typeof value === "object" &&
        Array.isArray((value as { answers?: unknown }).answers)
      ) {
        return (value as { answers: unknown[] }).answers.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
      return [];
    })
    .join(", ");
}

function bracketedPaste(value: string): string {
  return `\x1b[200~${value}\x1b[201~\r`;
}

function clearTurnTimers(turn: ActiveTurnState): void {
  if (turn.idleTimer) clearTimeout(turn.idleTimer);
  if (turn.noOutputTimer) clearTimeout(turn.noOutputTimer);
  if (turn.hardTimeoutTimer) clearTimeout(turn.hardTimeoutTimer);
  turn.idleTimer = undefined;
  turn.noOutputTimer = undefined;
  turn.hardTimeoutTimer = undefined;
}

function notePtyData(context: ClaudePtySessionContext, data: string): void {
  if (context.stopped) return;
  const activeTurn = context.activeTurn;
  if (activeTurn && !activeTurn.completed && data.length > 0) activeTurn.sawOutput = true;
}

function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    claudeProjectDirectoryName(cwd),
    `${sessionId}.jsonl`,
  );
}

function remoteClaudeTranscriptPath(remotePath: string, sessionId: string): string {
  return `.claude/projects/${claudeProjectDirectoryName(remotePath)}/${sessionId}.jsonl`;
}

async function findLocalClaudeTranscript(sessionId: string): Promise<string | undefined> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Keep scanning; Claude can store by cwd, and cwd can differ from T3's project path.
    }
  }
  return undefined;
}

function waitForInputReady(context: ClaudePtySessionContext): Promise<void> {
  const delayMs = context.inputReadyAtMs - Date.now();
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractClaudeAssistantText(record: unknown): { uuid: string; text: string } | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const entry = record as Record<string, unknown>;
  if (entry.type !== "assistant" || typeof entry.uuid !== "string") return undefined;
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
    })
    .join("");
  return text.length > 0 ? { uuid: entry.uuid, text } : undefined;
}

export function parseClaudeTranscriptAssistantMessages(
  jsonl: string,
): ReadonlyArray<{ readonly uuid: string; readonly text: string }> {
  const messages: Array<{ uuid: string; text: string }> = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const message = extractClaudeAssistantText(parsed);
      if (message) messages.push(message);
    } catch {
      // Claude can append while we read; ignore partial trailing JSON.
    }
  }
  return messages;
}

const makeClaudePtyAdapter = Effect.fn("makeClaudePtyAdapter")(function* () {
  const ptyAdapter = yield* PtyAdapter;
  const settingsService = yield* ServerSettingsService;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services();
  const runFork = Effect.runForkWith(services);
  const sessions = new Map<ThreadId, ClaudePtySessionContext>();

  const offerEvent = (event: ProviderRuntimeEvent) => {
    runFork(Queue.offer(events, event));
  };

  const readClaudeTranscript = async (context: ClaudePtySessionContext): Promise<string> => {
    const sshProject =
      context.projectLocation?.kind === "ssh" ? context.projectLocation : undefined;
    if (!sshProject) {
      const exactPath = claudeTranscriptPath(context.cwd, context.sessionId);
      try {
        return await readFile(exactPath, "utf8");
      } catch (error) {
        const fallbackPath = await findLocalClaudeTranscript(context.sessionId);
        if (fallbackPath) return await readFile(fallbackPath, "utf8");
        throw error;
      }
    }

    const remotePath = remoteClaudeTranscriptPath(sshProject.remotePath, context.sessionId);
    const remoteScript = `${REMOTE_CLAUDE_PATH_SETUP}; if [ -f ${shellQuote(
      remotePath,
    )} ]; then cat ${shellQuote(
      remotePath,
    )}; else found=$(find "$HOME/.claude/projects" -name ${shellQuote(
      `${context.sessionId}.jsonl`,
    )} -type f -print -quit 2>/dev/null); [ -n "$found" ] && cat "$found" || true; fi`;
    const remoteCommand = ["exec", "/bin/sh", "-lc", shellQuote(remoteScript)].join(" ");
    const { stdout } = await execFileAsync("ssh", [
      "-T",
      ...(sshProject.port !== undefined ? ["-p", String(sshProject.port)] : []),
      sshProject.host,
      remoteCommand,
    ]);
    return stdout;
  };

  const readSeenAssistantUuids = async (
    context: ClaudePtySessionContext,
  ): Promise<ReadonlySet<string>> => {
    try {
      const transcript = await readClaudeTranscript(context);
      return new Set(
        parseClaudeTranscriptAssistantMessages(transcript).map((message) => message.uuid),
      );
    } catch {
      return new Set();
    }
  };

  const completeTurn = (context: ClaudePtySessionContext, reason: "idle" | "hard-timeout") => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) return;
    activeTurn.completed = true;
    clearTurnTimers(activeTurn);
    const completedAt = nowIso();
    offerEvent({
      type: "item.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: completedAt,
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      itemId: activeTurn.itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        ...(activeTurn.outputText.length > 0 ? { detail: activeTurn.outputText } : {}),
      },
    });
    offerEvent({
      type: "turn.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: completedAt,
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      payload: {
        state: reason === "hard-timeout" ? "failed" : "completed",
        ...(reason === "hard-timeout" ? { errorMessage: "Claude PTY turn timed out." } : {}),
      },
    });
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: completedAt,
      resumeCursor: claudePtyResumeCursor(context.sessionId),
    };
    context.activeTurn = undefined;
    offerEvent({
      type: "session.state.changed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: completedAt,
      threadId: context.session.threadId,
      payload: {
        state: "ready",
        ...(reason === "hard-timeout" ? { reason: "turn-timeout" } : {}),
      },
    });
  };

  const scheduleIdleCompletion = (context: ClaudePtySessionContext) => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) return;
    if (activeTurn.idleTimer) clearTimeout(activeTurn.idleTimer);
    activeTurn.idleTimer = setTimeout(() => completeTurn(context, "idle"), TURN_IDLE_COMPLETE_MS);
  };

  const emitTranscriptMessageForTurn = (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
    text: string,
  ) => {
    activeTurn.outputText = text;
    activeTurn.sawOutput = true;
    for (const delta of chunkPtyDelta(text)) {
      offerEvent({
        type: "content.delta",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: context.session.threadId,
        turnId: activeTurn.turnId,
        itemId: activeTurn.itemId,
        payload: {
          streamKind: "assistant_text",
          delta,
        },
      });
      activeTurn.emittedLength += delta.length;
    }
    scheduleIdleCompletion(context);
  };

  const pollTranscriptForTurn = async (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
  ) => {
    while (!context.stopped && context.activeTurn === activeTurn && !activeTurn.completed) {
      try {
        const transcript = await readClaudeTranscript(context);
        const nextMessage = parseClaudeTranscriptAssistantMessages(transcript).find(
          (message) => !activeTurn.seenAssistantUuids.has(message.uuid),
        );
        if (nextMessage) {
          emitTranscriptMessageForTurn(context, activeTurn, nextMessage.text);
          return;
        }
      } catch {
        // The transcript file may not exist until Claude records the first turn.
      }
      await sleep(TRANSCRIPT_POLL_MS);
    }
  };

  const failActiveTurn = (context: ClaudePtySessionContext, message: string) => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) return;
    activeTurn.completed = true;
    clearTurnTimers(activeTurn);
    const failedAt = nowIso();
    offerEvent({
      type: "turn.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: failedAt,
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      payload: {
        state: "failed",
        errorMessage: message,
      },
    });
    context.activeTurn = undefined;
  };

  const markExited = (context: ClaudePtySessionContext, detail: string) => {
    if (context.stopped) return;
    context.stopped = true;
    failActiveTurn(context, detail);
    const exitedAt = nowIso();
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: exitedAt,
      lastError: detail,
    };
    offerEvent({
      type: "runtime.error",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: exitedAt,
      threadId: context.session.threadId,
      payload: {
        message: detail,
        class: "transport_error",
      },
    });
    offerEvent({
      type: "session.exited",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: exitedAt,
      threadId: context.session.threadId,
      payload: {
        reason: detail,
        recoverable: true,
        exitKind: "error",
      },
    });
  };

  const ensureContext = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    if (!context) {
      throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    if (context.stopped) {
      throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
    }
    return context;
  };

  const startSession: ClaudePtyAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        existing.pty.write("/exit\r");
        existing.pty.kill();
        existing.removeDataListener();
        existing.removeExitListener();
        sessions.delete(input.threadId);
      }

      const settings = yield* settingsService.getSettings.pipe(
        Effect.map((current) => current.providers.claudePty),
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const resumeState = readResumeState(input.resumeCursor);
      const sessionId = resumeState?.sessionId ?? randomUUID();
      const isResuming = resumeState?.sessionId !== undefined;
      const modelSelection =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
      const caps = getClaudeModelCapabilities(modelSelection?.model);
      const effort =
        modelSelection?.options?.effort &&
        caps.reasoningEffortLevels.some((level) => level.value === modelSelection.options?.effort)
          ? modelSelection.options.effort
          : undefined;
      const args = buildClaudeArgs({
        model: modelSelection?.model,
        effort,
        runtimeMode: input.runtimeMode,
        sessionId,
        resume: isResuming,
        threadId: input.threadId,
      });
      const launch = buildClaudePtyLaunch({
        binaryPath: settings.binaryPath,
        cwd: input.cwd,
        projectLocation: input.projectLocation,
        args,
      });

      const pty = yield* ptyAdapter
        .spawn({
          shell: launch.shell,
          args: [...launch.args],
          cwd: launch.cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: process.env,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        );

      const createdAt = nowIso();
      let context!: ClaudePtySessionContext;
      const removeDataListener = pty.onData((data) => notePtyData(context, data));
      const removeExitListener = pty.onExit((event) =>
        markExited(
          context,
          `Claude PTY process exited (code=${event.exitCode}, signal=${event.signal}).`,
        ),
      );
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        threadId: input.threadId,
        resumeCursor: claudePtyResumeCursor(sessionId),
        createdAt,
        updatedAt: createdAt,
      };
      context = {
        session,
        pty,
        sessionId,
        cwd: input.projectLocation?.kind === "ssh" ? input.projectLocation.remotePath : launch.cwd,
        projectLocation: input.projectLocation,
        inputReadyAtMs: Date.now() + INPUT_READY_DELAY_MS,
        activeTurn: undefined,
        stopped: false,
        removeDataListener,
        removeExitListener,
      };
      sessions.set(input.threadId, context);

      offerEvent({
        type: "session.started",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt,
        threadId: input.threadId,
        payload: {
          message: "Claude PTY session started.",
          resume: claudePtyResumeCursor(sessionId),
        },
      });
      offerEvent({
        type: "session.configured",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt,
        threadId: input.threadId,
        payload: {
          config: {
            mode: "interactive-pty",
            shell: launch.shell,
            args: launch.args,
            permissionMode: runtimePermissionMode(input),
          },
        },
      });
      offerEvent({
        type: "session.state.changed",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt,
        threadId: input.threadId,
        payload: { state: "ready" },
      });

      return session;
    },
  );

  const sendTurn: ClaudePtyAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* Effect.try({
      try: () => ensureContext(input.threadId),
      catch: (cause) => cause as ProviderAdapterError,
    });
    if (input.interactionMode === "auto") {
      const warningAt = nowIso();
      offerEvent({
        type: "runtime.warning",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: warningAt,
        threadId: input.threadId,
        payload: {
          message: "Claude PTY provider does not support auto mode yet.",
        },
      });
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "Claude PTY provider does not support auto mode yet.",
      });
    }
    if (context.activeTurn && !context.activeTurn.completed) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "Claude PTY already has an active turn.",
      });
    }
    const text = input.input?.trim();
    if (!text) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Claude PTY requires non-empty text input.",
      });
    }

    const startedAt = nowIso();
    const nextTurnId = turnId();
    const nextItemId = itemId();
    const seenAssistantUuids = yield* Effect.promise(() => readSeenAssistantUuids(context));
    const activeTurn: ActiveTurnState = {
      turnId: nextTurnId,
      startedAt,
      itemId: nextItemId,
      emittedLength: 0,
      outputText: "",
      seenAssistantUuids,
      sawOutput: false,
      completed: false,
      idleTimer: undefined,
      noOutputTimer: undefined,
      hardTimeoutTimer: undefined,
    };
    context.activeTurn = activeTurn;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: nextTurnId,
      updatedAt: startedAt,
      ...(input.modelSelection?.provider === PROVIDER ? { model: input.modelSelection.model } : {}),
    };
    offerEvent({
      type: "turn.started",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: startedAt,
      threadId: input.threadId,
      turnId: nextTurnId,
      payload: {
        ...(input.modelSelection?.provider === PROVIDER
          ? { model: input.modelSelection.model }
          : {}),
        ...(input.modelSelection?.provider === PROVIDER && input.modelSelection.options?.effort
          ? { effort: input.modelSelection.options.effort }
          : {}),
      },
    });
    offerEvent({
      type: "session.state.changed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: startedAt,
      threadId: input.threadId,
      payload: { state: "running" },
    });

    activeTurn.noOutputTimer = setTimeout(() => {
      if (activeTurn.completed || activeTurn.sawOutput) return;
      offerEvent({
        type: "runtime.warning",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: input.threadId,
        turnId: nextTurnId,
        payload: {
          message: "Claude PTY has not produced output yet.",
        },
      });
    }, TURN_NO_OUTPUT_WARNING_MS);
    activeTurn.hardTimeoutTimer = setTimeout(
      () => completeTurn(context, "hard-timeout"),
      TURN_HARD_TIMEOUT_MS,
    );
    void pollTranscriptForTurn(context, activeTurn);

    yield* Effect.promise(() => waitForInputReady(context));
    if (activeTurn.completed || context.activeTurn !== activeTurn || context.stopped) {
      return {
        threadId: input.threadId,
        turnId: nextTurnId,
        resumeCursor: claudePtyResumeCursor(context.sessionId),
      } satisfies ProviderTurnStartResult;
    }
    context.pty.write(bracketedPaste(text));
    if (input.attachments && input.attachments.length > 0) {
      offerEvent({
        type: "runtime.warning",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: input.threadId,
        turnId: nextTurnId,
        payload: {
          message: "Claude PTY does not support T3 attachments yet.",
          detail: { attachmentCount: input.attachments.length },
        },
      });
    }

    return {
      threadId: input.threadId,
      turnId: nextTurnId,
      resumeCursor: claudePtyResumeCursor(context.sessionId),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: ClaudePtyAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = yield* Effect.try({
        try: () => ensureContext(threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      context.pty.write("\x03");
      const activeTurn = context.activeTurn;
      if (activeTurn && !activeTurn.completed) {
        activeTurn.completed = true;
        clearTurnTimers(activeTurn);
        const interruptedAt = nowIso();
        offerEvent({
          type: "turn.completed",
          eventId: eventId(),
          provider: PROVIDER,
          createdAt: interruptedAt,
          threadId,
          turnId: activeTurn.turnId,
          payload: { state: "interrupted", stopReason: "interrupt" },
        });
        context.activeTurn = undefined;
      }
    },
  );

  const respondToRequest: ClaudePtyAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, _requestId, decision: ProviderApprovalDecision) {
      const context = yield* Effect.try({
        try: () => ensureContext(threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      context.pty.write(decision === "accept" || decision === "acceptForSession" ? "y\r" : "n\r");
    },
  );

  const respondToUserInput: ClaudePtyAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, _requestId, answers: ProviderUserInputAnswers) {
    const context = yield* Effect.try({
      try: () => ensureContext(threadId),
      catch: (cause) => cause as ProviderAdapterError,
    });
    const answerText = bestEffortAnswerText(answers);
    if (answerText.length > 0) {
      context.pty.write(bracketedPaste(answerText));
    }
  });

  const stopSession: ClaudePtyAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context || context.stopped) return;
      context.stopped = true;
      if (context.activeTurn) {
        clearTurnTimers(context.activeTurn);
        context.activeTurn = undefined;
      }
      context.pty.write("/exit\r");
      setTimeout(() => {
        try {
          context.pty.kill();
        } catch {
          // Best effort cleanup.
        }
      }, 2_000);
      context.removeDataListener();
      context.removeExitListener();
      sessions.delete(threadId);
      const stoppedAt = nowIso();
      offerEvent({
        type: "session.state.changed",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: stoppedAt,
        threadId,
        payload: { state: "stopped" },
      });
      offerEvent({
        type: "session.exited",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: stoppedAt,
        threadId,
        payload: {
          reason: "Claude PTY session stopped.",
          recoverable: true,
          exitKind: "graceful",
        },
      });
    });

  const readThread: ClaudePtyAdapterShape["readThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  const rollbackThread: ClaudePtyAdapterShape["rollbackThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "restart-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () =>
      Effect.succeed(Array.from(sessions.values()).map((context) => context.session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread,
    rollbackThread,
    stopAll: () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        discard: true,
      }),
    streamEvents: Stream.fromQueue(events),
  } satisfies ClaudePtyAdapterShape;
});

export const ClaudePtyAdapterLive = Layer.effect(ClaudePtyAdapter, makeClaudePtyAdapter());

export function makeClaudePtyAdapterLive() {
  return Layer.effect(ClaudePtyAdapter, makeClaudePtyAdapter());
}
