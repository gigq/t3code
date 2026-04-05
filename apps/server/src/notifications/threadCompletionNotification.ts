import type {
  MessageId,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadCompletionNotificationPayload,
} from "@t3tools/contracts";
import { isAutoModeNoopMessage } from "@t3tools/shared/autoMode";

const MAX_BODY_CHARS = 160;
const DEFAULT_NOTIFICATION_TITLE = "Thread completed";

function normalizeNotificationBody(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "Assistant finished responding.";
  }
  if (collapsed.length <= MAX_BODY_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`;
}

export function isThreadCompletionNotificationEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: "thread.turn-completed" }> {
  return event.type === "thread.turn-completed";
}

function resolveNotificationTitle(projectTitle: string | null, threadTitle: string | null): string {
  const normalizedProjectTitle = projectTitle?.trim();
  const normalizedThreadTitle = threadTitle?.trim();
  if (normalizedProjectTitle && normalizedThreadTitle) {
    return `${normalizedProjectTitle} - ${normalizedThreadTitle}`;
  }
  if (normalizedThreadTitle) {
    return normalizedThreadTitle;
  }
  if (normalizedProjectTitle) {
    return normalizedProjectTitle;
  }
  return DEFAULT_NOTIFICATION_TITLE;
}

function resolveAssistantMessageText(
  snapshot: OrchestrationReadModel,
  threadId: string,
  turnId: string,
  assistantMessageId: MessageId | null,
): string {
  const thread = snapshot.threads.find(
    (candidate) => candidate.id === threadId && candidate.deletedAt === null,
  );
  if (!thread) {
    return "Assistant finished responding.";
  }

  const message =
    (assistantMessageId !== null
      ? thread.messages.find(
          (candidate) => candidate.id === assistantMessageId && candidate.role === "assistant",
        )
      : undefined) ??
    [...thread.messages]
      .filter((candidate) => candidate.role === "assistant" && candidate.turnId === turnId)
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.createdAt.localeCompare(left.createdAt),
      )[0];

  if (message && isAutoModeNoopMessage(message.text)) {
    return "";
  }

  return normalizeNotificationBody(message?.text ?? "");
}

export function buildThreadCompletionNotification(
  event: OrchestrationEvent,
  snapshot: OrchestrationReadModel,
): ThreadCompletionNotificationPayload | null {
  if (!isThreadCompletionNotificationEvent(event)) {
    return null;
  }

  const thread = snapshot.threads.find(
    (candidate) => candidate.id === event.payload.threadId && candidate.deletedAt === null,
  );
  const project = snapshot.projects.find(
    (candidate) => candidate.id === thread?.projectId && candidate.deletedAt === null,
  );
  const body = resolveAssistantMessageText(
    snapshot,
    event.payload.threadId,
    event.payload.turnId,
    event.payload.assistantMessageId,
  );
  if (body.length === 0) {
    return null;
  }

  return {
    threadId: event.payload.threadId,
    title: resolveNotificationTitle(project?.title ?? null, thread?.title ?? null),
    body,
    tag: `thread-completed:${event.payload.turnId}`,
    urlPath: `/${event.payload.threadId}`,
  };
}
