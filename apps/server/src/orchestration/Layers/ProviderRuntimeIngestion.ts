import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Fiber, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  AUTO_MODE_MAX_CONSECUTIVE_NOOPS,
  AUTO_MODE_NOOP_SENTINEL,
  parseAutoModeControlMessage,
} from "@t3tools/shared/autoMode";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const DEFAULT_TURN_COMPLETION_FALLBACK_DELAY_MS = 20_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

function getTurnCompletionFallbackDelay(): Duration.Duration {
  const rawValue = process.env.T3CODE_TURN_COMPLETION_FALLBACK_DELAY_MS;
  const parsedValue = rawValue === undefined ? Number.NaN : Number.parseInt(rawValue, 10);
  return Duration.millis(
    Number.isFinite(parsedValue) && parsedValue > 0
      ? parsedValue
      : DEFAULT_TURN_COMPLETION_FALLBACK_DELAY_MS,
  );
}

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function isMeaningfulTurnCompletionFallbackActivity(event: ProviderRuntimeEvent): boolean {
  if (event.turnId === undefined) {
    return false;
  }
  switch (event.type) {
    case "thread.token-usage.updated":
    case "turn.completed":
    case "request.opened":
    case "request.resolved":
    case "user-input.requested":
    case "user-input.resolved":
      return false;
    default:
      return true;
  }
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function runtimeTurnStateToCompletionState(
  value: "completed" | "failed" | "interrupted" | "cancelled",
): "completed" | "interrupted" | "error" {
  switch (value) {
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "completed":
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function nextActiveTurnIdForLifecycleEvent(input: {
  readonly event:
    | Extract<ProviderRuntimeEvent, { type: "session.started" }>
    | Extract<ProviderRuntimeEvent, { type: "session.state.changed" }>
    | Extract<ProviderRuntimeEvent, { type: "session.exited" }>
    | Extract<ProviderRuntimeEvent, { type: "thread.started" }>
    | Extract<ProviderRuntimeEvent, { type: "turn.started" }>
    | Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
  readonly activeTurnId: TurnId | null;
  readonly currentSessionStatus:
    | "starting"
    | "running"
    | "ready"
    | "idle"
    | "interrupted"
    | "stopped"
    | "error"
    | null;
  readonly eventTurnId: TurnId | undefined;
}): TurnId | null {
  switch (input.event.type) {
    case "turn.started":
      return input.eventTurnId ?? null;
    case "turn.completed":
    case "session.exited":
      return null;
    case "session.state.changed": {
      const nextStatus = orchestrationSessionStatusFromRuntimeState(input.event.payload.state);
      if (nextStatus === "running") {
        return input.activeTurnId;
      }
      if (nextStatus === "starting" && input.currentSessionStatus === "running") {
        return input.activeTurnId;
      }
      return null;
    }
    case "session.started":
    case "thread.started":
      return input.currentSessionStatus === "running" ? input.activeTurnId : null;
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.fn("make")(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const isGitRepoForThread = Effect.fn("isGitRepoForThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap(
        Effect.fn("appendBufferedAssistantText")(function* (existingText) {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const finalizeAssistantMessage = Effect.fn("finalizeAssistantMessage")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    existingText?: string;
  }) {
    const bufferedText = yield* takeBufferedAssistantText(input.messageId);
    const fallbackText = (input.fallbackText?.trim().length ?? 0) > 0 ? input.fallbackText! : "";
    const existingText = (input.existingText?.trim().length ?? 0) > 0 ? input.existingText! : "";
    const rawText =
      bufferedText.length > 0
        ? bufferedText
        : fallbackText.length > 0
          ? fallbackText
          : existingText;
    const autoModeControl = parseAutoModeControlMessage(rawText, new Date(input.createdAt));
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    const isThreadInAutoMode = thread?.interactionMode === "auto";
    const consecutiveAutoNoops = thread?.consecutiveAutoNoops ?? 0;
    const shouldEmitCompletionDelta = bufferedText.length > 0 || fallbackText.length > 0;
    const text =
      (autoModeControl?.kind === "defer" || autoModeControl?.kind === "stop") &&
      shouldEmitCompletionDelta
        ? AUTO_MODE_NOOP_SENTINEL
        : rawText;

    if (isThreadInAutoMode && autoModeControl?.kind === "noop") {
      const nextConsecutiveAutoNoops = consecutiveAutoNoops + 1;
      yield* orchestrationEngine.dispatch({
        type: "thread.auto-noop-count.set",
        commandId: providerCommandId(input.event, "auto-noop-count-set"),
        threadId: input.threadId,
        consecutiveAutoNoops: nextConsecutiveAutoNoops,
        createdAt: input.createdAt,
      });

      if (nextConsecutiveAutoNoops >= AUTO_MODE_MAX_CONSECUTIVE_NOOPS) {
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(input.event, "auto-noop-limit-activity"),
          threadId: input.threadId,
          activity: {
            id: input.event.eventId,
            tone: "tool",
            kind: "auto.stop.limit",
            summary: "Auto stopped",
            payload: {
              reason: "noop-limit",
              consecutiveAutoNoops: nextConsecutiveAutoNoops,
            },
            turnId: input.turnId ?? null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: providerCommandId(input.event, "auto-noop-limit-interaction-mode-set"),
          threadId: input.threadId,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: input.createdAt,
        });
      }
    } else if (
      isThreadInAutoMode &&
      consecutiveAutoNoops > 0 &&
      autoModeControl?.kind !== "defer"
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.auto-noop-count.set",
        commandId: providerCommandId(input.event, "auto-noop-count-reset"),
        threadId: input.threadId,
        consecutiveAutoNoops: 0,
        createdAt: input.createdAt,
      });
    }

    if (shouldEmitCompletionDelta && text.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: text,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
    }

    if (autoModeControl?.kind === "defer") {
      yield* orchestrationEngine.dispatch({
        type: "thread.auto-defer.set",
        commandId: providerCommandId(input.event, "auto-defer-set"),
        threadId: input.threadId,
        autoDeferUntil: autoModeControl.deferUntil,
        createdAt: input.createdAt,
      });
    }

    if (autoModeControl?.kind === "stop") {
      yield* orchestrationEngine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: providerCommandId(input.event, "auto-stop-interaction-mode-set"),
        threadId: input.threadId,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: input.createdAt,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: input.createdAt,
    });
    yield* clearAssistantMessageState(input.messageId);
  });

  const upsertProposedPlan = Effect.fn("upsertProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
      dismissedAt: string | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) {
    const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
    if (!planMarkdown) {
      return;
    }

    const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: providerCommandId(input.event, "proposed-plan-upsert"),
      threadId: input.threadId,
      proposedPlan: {
        id: input.planId,
        turnId: input.turnId ?? null,
        planMarkdown,
        implementedAt: existingPlan?.implementedAt ?? null,
        implementationThreadId: existingPlan?.implementationThreadId ?? null,
        dismissedAt: existingPlan?.dismissedAt ?? null,
        createdAt: existingPlan?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });
  });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
      dismissedAt: string | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
    const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
    const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
    if (!planMarkdown) {
      return;
    }

    yield* upsertProposedPlan({
      event: input.event,
      threadId: input.threadId,
      threadProposedPlans: input.threadProposedPlans,
      planId: input.planId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      planMarkdown,
      createdAt:
        bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
          ? bufferedPlan.createdAt
          : input.updatedAt,
      updatedAt: input.updatedAt,
    });
    yield* clearBufferedProposedPlan(input.planId);
  });

  const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
    threadId: ThreadId,
  ) {
    const prefix = `${threadId}:`;
    const proposedPlanPrefix = `plan:${threadId}:`;
    const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
    yield* Effect.forEach(
      turnKeys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }

        const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
        if (Option.isSome(messageIds)) {
          yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    for (const key of pendingTurnCompletionFallbacks.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const pending = pendingTurnCompletionFallbacks.get(key);
      pendingTurnCompletionFallbacks.delete(key);
      if (pending) {
        yield* Fiber.interrupt(pending.fiber);
      }
    }
    for (const key of Array.from(completedTurnKeys)) {
      if (key.startsWith(prefix)) {
        completedTurnKeys.delete(key);
      }
    }
    for (const key of Array.from(turnCompletionTrackingByTurnKey.keys())) {
      if (key.startsWith(prefix)) {
        turnCompletionTrackingByTurnKey.delete(key);
      }
    }
  });

  const pendingTurnCompletionFallbacks = new Map<
    string,
    {
      fiber: Fiber.Fiber<void, never>;
      assistantMessageId: MessageId | null;
      activitySequence: number;
    }
  >();
  const turnCompletionTrackingByTurnKey = new Map<
    string,
    {
      assistantMessageId: MessageId | null;
      activitySequence: number;
      activeToolItemIds: Set<string>;
    }
  >();
  const completedTurnKeys = new Set<string>();

  const getOrCreateTurnCompletionTracking = (
    threadId: ThreadId,
    turnId: TurnId,
  ): {
    assistantMessageId: MessageId | null;
    activitySequence: number;
    activeToolItemIds: Set<string>;
  } => {
    const key = providerTurnKey(threadId, turnId);
    const existing = turnCompletionTrackingByTurnKey.get(key);
    if (existing) {
      return existing;
    }
    const created = {
      assistantMessageId: null,
      activitySequence: 0,
      activeToolItemIds: new Set<string>(),
    };
    turnCompletionTrackingByTurnKey.set(key, created);
    return created;
  };

  const clearTurnCompletionTracking = Effect.fn("clearTurnCompletionTracking")(function* (
    threadId: ThreadId,
    turnId: TurnId,
  ) {
    const key = providerTurnKey(threadId, turnId);
    const pending = pendingTurnCompletionFallbacks.get(key);
    pendingTurnCompletionFallbacks.delete(key);
    if (pending) {
      yield* Fiber.interrupt(pending.fiber);
    }
    turnCompletionTrackingByTurnKey.delete(key);
  });

  const cancelPendingTurnCompletionFallback = Effect.fn("cancelPendingTurnCompletionFallback")(
    function* (threadId: ThreadId, turnId: TurnId) {
      const key = providerTurnKey(threadId, turnId);
      const pending = pendingTurnCompletionFallbacks.get(key);
      if (!pending) {
        return;
      }
      pendingTurnCompletionFallbacks.delete(key);
      yield* Fiber.interrupt(pending.fiber);
    },
  );

  const dispatchThreadTurnCompleted = Effect.fn("dispatchThreadTurnCompleted")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    assistantMessageId: MessageId | null;
    state: "completed" | "interrupted" | "error";
    completedAt: string;
  }) {
    const key = providerTurnKey(input.threadId, input.turnId);
    if (completedTurnKeys.has(key)) {
      return;
    }
    completedTurnKeys.add(key);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.complete",
      commandId: providerCommandId(input.event, "thread-turn-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
      state: input.state,
      completedAt: input.completedAt,
      createdAt: input.completedAt,
    });
  });

  const schedulePendingTurnCompletionFallback = Effect.fn("schedulePendingTurnCompletionFallback")(
    function* (input: {
      event: ProviderRuntimeEvent;
      threadId: ThreadId;
      turnId: TurnId;
      assistantMessageId: MessageId | null;
      activitySequence: number;
    }) {
      yield* cancelPendingTurnCompletionFallback(input.threadId, input.turnId);
      const key = providerTurnKey(input.threadId, input.turnId);
      const fiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(getTurnCompletionFallbackDelay());
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === input.threadId);
        const tracking = turnCompletionTrackingByTurnKey.get(key);
        if (
          !thread ||
          thread.session?.status !== "running" ||
          !sameId(thread.session.activeTurnId, input.turnId) ||
          !tracking ||
          tracking.activitySequence !== input.activitySequence ||
          tracking.activeToolItemIds.size > 0
        ) {
          return;
        }

        const completedAt = new Date().toISOString();

        yield* dispatchThreadTurnCompleted({
          event: input.event,
          threadId: input.threadId,
          turnId: input.turnId,
          assistantMessageId: input.assistantMessageId,
          state: "completed",
          completedAt,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(input.event, "thread-session-set-fallback-complete"),
          threadId: input.threadId,
          session: {
            threadId: input.threadId,
            status: "ready",
            providerName: input.event.provider,
            runtimeMode: thread.session.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
          createdAt: completedAt,
        });
        yield* Effect.logInfo("provider runtime ingestion synthesized missing turn completion", {
          threadId: input.threadId,
          turnId: input.turnId,
          assistantMessageId: input.assistantMessageId,
        });
        yield* clearTurnCompletionTracking(input.threadId, input.turnId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider runtime ingestion fallback completion failed", {
            threadId: input.threadId,
            turnId: input.turnId,
            assistantMessageId: input.assistantMessageId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingTurnCompletionFallbacks.delete(key);
          }),
        ),
        Effect.forkScoped,
      );

      pendingTurnCompletionFallbacks.set(key, {
        fiber,
        assistantMessageId: input.assistantMessageId,
        activitySequence: input.activitySequence,
      });
    },
  );

  const updateTurnCompletionTrackingForEvent = Effect.fn("updateTurnCompletionTrackingForEvent")(
    function* (event: ProviderRuntimeEvent, threadId: ThreadId, turnId: TurnId) {
      const tracking = getOrCreateTurnCompletionTracking(threadId, turnId);
      if (
        event.itemId &&
        "payload" in event &&
        event.payload &&
        typeof event.payload === "object"
      ) {
        if (
          "itemType" in event.payload &&
          typeof event.payload.itemType === "string" &&
          isToolLifecycleItemType(event.payload.itemType)
        ) {
          if (event.type === "item.started") {
            tracking.activeToolItemIds.add(event.itemId);
          } else if (event.type === "item.completed") {
            tracking.activeToolItemIds.delete(event.itemId);
          } else if (
            event.type === "item.updated" &&
            "status" in event.payload &&
            typeof event.payload.status === "string"
          ) {
            if (event.payload.status === "inProgress") {
              tracking.activeToolItemIds.add(event.itemId);
            } else {
              tracking.activeToolItemIds.delete(event.itemId);
            }
          }
        }
      }

      if (!isMeaningfulTurnCompletionFallbackActivity(event)) {
        return;
      }

      tracking.activitySequence += 1;
      if (tracking.assistantMessageId === null) {
        return;
      }

      yield* schedulePendingTurnCompletionFallback({
        event,
        threadId,
        turnId,
        assistantMessageId: tracking.assistantMessageId,
        activitySequence: tracking.activitySequence,
      });
    },
  );

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const sourceThread = readModel.threads.find((entry) => entry.id === sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
    if (!thread) return;

    const now = event.createdAt;
    const eventTurnId = toTurnId(event.turnId);
    const activeTurnId = thread.session?.activeTurnId ?? null;
    const activeTurnProjection = activeTurnId
      ? yield* projectionTurnRepository
          .getByTurnId({
            threadId: thread.id,
            turnId: activeTurnId,
          })
          .pipe(Effect.orElseSucceed(() => Option.none()))
      : Option.none();
    const activeTurnLooksSettledInProjection =
      Option.isSome(activeTurnProjection) &&
      (activeTurnProjection.value.state === "completed" ||
        activeTurnProjection.value.state === "error" ||
        activeTurnProjection.value.state === "interrupted");
    const activeTurnLooksCompletedInReadModel =
      activeTurnId !== null &&
      thread.latestTurn !== null &&
      sameId(thread.latestTurn.turnId, activeTurnId) &&
      (thread.latestTurn.state === "completed" ||
        thread.latestTurn.state === "error" ||
        thread.latestTurn.state === "interrupted");
    const normalizedActiveTurnId =
      activeTurnLooksCompletedInReadModel || activeTurnLooksSettledInProjection
        ? null
        : activeTurnId;
    const shouldRecoverStaleSessionFromTurnScopedEvent =
      normalizedActiveTurnId === null &&
      activeTurnId !== null &&
      eventTurnId !== undefined &&
      !sameId(activeTurnId, eventTurnId) &&
      event.type !== "turn.started" &&
      event.type !== "turn.completed";
    const effectiveSessionStatus = shouldRecoverStaleSessionFromTurnScopedEvent
      ? "running"
      : (thread.session?.status ?? null);
    const effectiveActiveTurnId = shouldRecoverStaleSessionFromTurnScopedEvent
      ? (eventTurnId ?? null)
      : normalizedActiveTurnId;

    if (shouldRecoverStaleSessionFromTurnScopedEvent && eventTurnId) {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: providerCommandId(event, "thread-session-set-stale-turn-recovery"),
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: event.provider,
          runtimeMode: thread.session?.runtimeMode ?? "full-access",
          activeTurnId: eventTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
    }

    const shouldDeferReadySessionTransition =
      event.type === "session.state.changed" &&
      event.payload.state === "ready" &&
      effectiveActiveTurnId !== null;

    const conflictsWithActiveTurn =
      effectiveActiveTurnId !== null &&
      eventTurnId !== undefined &&
      !sameId(effectiveActiveTurnId, eventTurnId);
    const missingTurnForActiveTurn = effectiveActiveTurnId !== null && eventTurnId === undefined;

    const shouldApplyThreadLifecycle = (() => {
      if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
        return true;
      }
      switch (event.type) {
        case "session.exited":
          return true;
        case "session.started":
        case "thread.started":
          return true;
        case "turn.started":
          return !conflictsWithActiveTurn;
        case "turn.completed":
          if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
            return false;
          }
          // Only the active turn may close the lifecycle state.
          if (effectiveActiveTurnId !== null && eventTurnId !== undefined) {
            return sameId(effectiveActiveTurnId, eventTurnId);
          }
          // If no active turn is tracked, accept completion scoped to this thread.
          return true;
        case "session.state.changed":
          return !shouldDeferReadySessionTransition;
        default:
          return true;
      }
    })();
    const acceptedTurnStartedSourcePlan =
      event.type === "turn.started" && shouldApplyThreadLifecycle
        ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
        : null;

    if (eventTurnId) {
      yield* updateTurnCompletionTrackingForEvent(event, thread.id, eventTurnId);
      if (event.type === "turn.completed") {
        yield* clearTurnCompletionTracking(thread.id, eventTurnId);
      }
    }

    if (
      event.type === "session.started" ||
      event.type === "session.state.changed" ||
      event.type === "session.exited" ||
      event.type === "thread.started" ||
      event.type === "turn.started" ||
      event.type === "turn.completed"
    ) {
      const nextActiveTurnId = nextActiveTurnIdForLifecycleEvent({
        event,
        activeTurnId: effectiveActiveTurnId,
        currentSessionStatus: effectiveSessionStatus,
        eventTurnId,
      });
      const status = (() => {
        switch (event.type) {
          case "session.state.changed":
            return orchestrationSessionStatusFromRuntimeState(event.payload.state);
          case "turn.started":
            return "running";
          case "session.exited":
            return "stopped";
          case "turn.completed":
            return normalizeRuntimeTurnState(event.payload.state) === "failed" ? "error" : "ready";
          case "session.started":
          case "thread.started":
            // Provider thread/session start notifications can arrive during an
            // active turn; preserve turn-running state in that case.
            return effectiveSessionStatus === "running" ? "running" : "ready";
        }
      })();
      const lastError =
        event.type === "session.state.changed" && event.payload.state === "error"
          ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
          : event.type === "turn.completed" &&
              normalizeRuntimeTurnState(event.payload.state) === "failed"
            ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
            : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

      if (shouldApplyThreadLifecycle) {
        if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
          yield* markSourceProposedPlanImplemented(
            acceptedTurnStartedSourcePlan.sourceThreadId,
            acceptedTurnStartedSourcePlan.sourcePlanId,
            thread.id,
            now,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider runtime ingestion failed to mark source proposed plan", {
                eventId: event.eventId,
                eventType: event.type,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status,
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: nextActiveTurnId,
            lastError,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    const assistantDelta =
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : undefined;
    const proposedPlanDelta =
      event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

    if (assistantDelta && assistantDelta.length > 0) {
      const assistantMessageId = MessageId.makeUnsafe(
        `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
      );
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
      );
      if (assistantDeliveryMode === "buffered") {
        const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
        if (spillChunk.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: spillChunk,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      } else {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(event, "assistant-delta"),
          threadId: thread.id,
          messageId: assistantMessageId,
          delta: assistantDelta,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
      }
    }

    if (proposedPlanDelta && proposedPlanDelta.length > 0) {
      const planId = proposedPlanIdFromEvent(event, thread.id);
      yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
    }

    const assistantCompletion =
      event.type === "item.completed" && event.payload.itemType === "assistant_message"
        ? {
            messageId: MessageId.makeUnsafe(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            ),
            fallbackText: event.payload.detail,
          }
        : undefined;
    const proposedPlanCompletion =
      event.type === "turn.proposed.completed"
        ? {
            planId: proposedPlanIdFromEvent(event, thread.id),
            turnId: toTurnId(event.turnId),
            planMarkdown: event.payload.planMarkdown,
          }
        : undefined;

    if (assistantCompletion) {
      const assistantMessageId = assistantCompletion.messageId;
      const turnId = toTurnId(event.turnId);
      const existingAssistantMessage = thread.messages.find(
        (entry) => entry.id === assistantMessageId,
      );
      const shouldApplyFallbackCompletionText =
        !existingAssistantMessage || existingAssistantMessage.text.length === 0;
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      yield* finalizeAssistantMessage({
        event,
        threadId: thread.id,
        messageId: assistantMessageId,
        ...(turnId ? { turnId } : {}),
        createdAt: now,
        commandTag: "assistant-complete",
        finalDeltaCommandTag: "assistant-delta-finalize",
        ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
          ? { fallbackText: assistantCompletion.fallbackText }
          : {}),
        ...(existingAssistantMessage?.text ? { existingText: existingAssistantMessage.text } : {}),
      });

      if (turnId) {
        const tracking = getOrCreateTurnCompletionTracking(thread.id, turnId);
        tracking.assistantMessageId = assistantMessageId;
        yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        if (
          effectiveSessionStatus === "running" &&
          effectiveActiveTurnId !== null &&
          sameId(effectiveActiveTurnId, turnId)
        ) {
          yield* schedulePendingTurnCompletionFallback({
            event,
            threadId: thread.id,
            turnId,
            assistantMessageId,
            activitySequence: tracking.activitySequence,
          });
        }
      }
    }

    if (proposedPlanCompletion) {
      yield* finalizeBufferedProposedPlan({
        event,
        threadId: thread.id,
        threadProposedPlans: thread.proposedPlans,
        planId: proposedPlanCompletion.planId,
        ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
        fallbackMarkdown: proposedPlanCompletion.planMarkdown,
        updatedAt: now,
      });
    }

    if (shouldDeferReadySessionTransition) {
      if (effectiveActiveTurnId === null) {
        return;
      }
      const tracking = getOrCreateTurnCompletionTracking(thread.id, effectiveActiveTurnId);
      yield* schedulePendingTurnCompletionFallback({
        event,
        threadId: thread.id,
        turnId: effectiveActiveTurnId,
        assistantMessageId: tracking.assistantMessageId,
        activitySequence: tracking.activitySequence,
      });
      yield* Effect.logInfo("provider runtime ingestion deferred ready session transition", {
        threadId: thread.id,
        turnId: effectiveActiveTurnId,
        assistantMessageId: tracking.assistantMessageId,
        activitySequence: tracking.activitySequence,
        activeToolItemCount: tracking.activeToolItemIds.size,
      });
    }

    if (event.type === "turn.completed" && shouldApplyThreadLifecycle) {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
        const assistantMessageId =
          assistantMessageIds.size > 0 ? (Array.from(assistantMessageIds).at(-1) ?? null) : null;
        yield* dispatchThreadTurnCompleted({
          event,
          threadId: thread.id,
          turnId,
          assistantMessageId,
          state: runtimeTurnStateToCompletionState(normalizeRuntimeTurnState(event.payload.state)),
          completedAt: now,
        });
        yield* Effect.forEach(
          assistantMessageIds,
          (assistantMessageId) => {
            const existingAssistantMessage = thread.messages.find(
              (entry) => entry.id === assistantMessageId,
            );
            return finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId,
              createdAt: now,
              commandTag: "assistant-complete-finalize",
              finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              ...(existingAssistantMessage?.text
                ? { existingText: existingAssistantMessage.text }
                : {}),
            });
          },
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
        yield* clearAssistantMessageIdsForTurn(thread.id, turnId);

        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanIdForTurn(thread.id, turnId),
          turnId,
          updatedAt: now,
        });
        yield* clearTurnCompletionTracking(thread.id, turnId);
      }
    }

    if (event.type === "session.exited") {
      yield* clearTurnStateForSession(thread.id);
    }

    if (event.type === "runtime.error") {
      const runtimeErrorMessage = event.payload.message;

      const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
        ? true
        : effectiveActiveTurnId === null ||
          eventTurnId === undefined ||
          sameId(effectiveActiveTurnId, eventTurnId);

      if (shouldApplyRuntimeError) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "runtime-error-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: eventTurnId ?? null,
            lastError: runtimeErrorMessage,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    if (event.type === "thread.metadata.updated" && event.payload.name) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: providerCommandId(event, "thread-meta-update"),
        threadId: thread.id,
        title: event.payload.name,
      });
    }

    if (event.type === "turn.diff.updated") {
      const turnId = toTurnId(event.turnId);
      if (turnId && (yield* isGitRepoForThread(thread.id))) {
        // Skip if a checkpoint already exists for this turn. A real
        // (non-placeholder) capture from CheckpointReactor should not
        // be clobbered, and dispatching a duplicate placeholder for the
        // same turnId would produce an unstable checkpointTurnCount.
        if (thread.checkpoints.some((c) => c.turnId === turnId)) {
          // Already tracked; no-op.
        } else {
          const assistantMessageId = MessageId.makeUnsafe(
            `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
          );
          const maxTurnCount = thread.checkpoints.reduce(
            (max, c) => Math.max(max, c.checkpointTurnCount),
            0,
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: providerCommandId(event, "thread-turn-diff-complete"),
            threadId: thread.id,
            turnId,
            completedAt: now,
            checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
            status: "missing",
            files: [],
            assistantMessageId,
            checkpointTurnCount: maxTurnCount + 1,
            createdAt: now,
          });
        }
      }
    }

    const activities = runtimeEventToActivities(event);
    yield* Effect.forEach(activities, (activity) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "thread-activity-append"),
        threadId: thread.id,
        activity,
        createdAt: activity.createdAt,
      }),
    ).pipe(Effect.asVoid);
  });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
