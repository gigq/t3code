import {
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ChatAttachment,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";

const FORKED_THREAD_TITLE_SUFFIX = " (fork)";
const FORKED_THREAD_TITLE_MAX_CHARS = 72;
const FORK_BOOTSTRAP_MIN_TRANSCRIPT_BUDGET = 8_000;
const FORK_IMPORTED_MESSAGE_PREFIX = "fork:";

export type ForkableOrchestrationMessage = OrchestrationMessage & {
  readonly role: "user" | "assistant";
};

export interface ForkedOrchestrationMessage {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly turnId: OrchestrationMessage["turnId"];
  readonly createdAt: string;
}

export interface ForkBootstrapCompaction {
  readonly compactedAt: string;
  readonly summary: string | null;
  readonly startMessageId?: string;
}

function clampTitle(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= FORKED_THREAD_TITLE_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, FORKED_THREAD_TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

function formatAttachmentSummary(attachments: ReadonlyArray<ChatAttachment> | undefined): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const names = attachments.map((attachment) => attachment.name).join(", ");
  return `\n[Attachments: ${names}]`;
}

function formatTranscriptEntry(message: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}): string {
  const label = message.role === "user" ? "User" : "Assistant";
  const normalizedText = message.text.trim();
  const attachmentSummary = formatAttachmentSummary(message.attachments);
  if (normalizedText.length === 0) {
    return `${label}:${attachmentSummary.length > 0 ? attachmentSummary : "\n[No text]"}`;
  }
  return `${label}:\n${normalizedText}${attachmentSummary}`;
}

function formatCompactionSummary(summary: string): string {
  return `Compaction summary:\n${summary.trim()}`;
}

export function buildForkedThreadTitle(sourceTitle: string): string {
  const normalized = sourceTitle.trim();
  if (normalized.length === 0) {
    return "Forked thread";
  }
  const suffixed = `${normalized}${FORKED_THREAD_TITLE_SUFFIX}`;
  return clampTitle(suffixed);
}

export function selectForkableMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<ForkableOrchestrationMessage> {
  return thread.messages.filter(isForkableMessage);
}

export function isForkableMessage(
  message: OrchestrationMessage,
): message is ForkableOrchestrationMessage {
  return (
    (message.role === "user" || message.role === "assistant") &&
    !message.streaming &&
    (message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0)
  );
}

export function isImportedForkMessageId(messageId: string): boolean {
  return messageId.startsWith(FORK_IMPORTED_MESSAGE_PREFIX);
}

export function isImportedForkMessage(message: Pick<OrchestrationMessage, "id">): boolean {
  return isImportedForkMessageId(message.id);
}

export function shouldBootstrapForkHistory(input: {
  readonly thread: Pick<OrchestrationThread, "messages">;
  readonly beforeMessageId: string;
}): boolean {
  const limitIndex = input.thread.messages.findIndex(
    (message) => message.id === input.beforeMessageId,
  );
  if (limitIndex <= 0) {
    return false;
  }

  const priorForkableMessages = input.thread.messages
    .slice(0, limitIndex)
    .filter(isForkableMessage);

  return (
    priorForkableMessages.some((message) => isImportedForkMessage(message)) &&
    !priorForkableMessages.some(
      (message) => message.role === "assistant" && !isImportedForkMessage(message),
    )
  );
}

function readCompactionSummary(activity: OrchestrationThreadActivity): string | null {
  const payload = activity.payload;
  if (payload && typeof payload === "object") {
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail.trim().length > 0) {
      return detail.trim();
    }
  }
  return activity.summary.trim().length > 0 ? activity.summary.trim() : null;
}

function readCompactionStartMessageId(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>).forkBootstrapStartMessageId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function findLatestForkCompaction(
  thread: Pick<OrchestrationThread, "activities">,
): ForkBootstrapCompaction | null {
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index];
    if (!activity || activity.kind !== "context-compaction") {
      continue;
    }
    const startMessageId = readCompactionStartMessageId(activity);
    return {
      compactedAt: activity.createdAt,
      summary: readCompactionSummary(activity),
      ...(startMessageId !== undefined ? { startMessageId } : {}),
    };
  }
  return null;
}

export function selectForkBootstrapMessages(input: {
  readonly thread: Pick<OrchestrationThread, "messages" | "activities">;
  readonly beforeMessageId?: string;
}): {
  readonly compaction: ForkBootstrapCompaction | null;
  readonly history: ReadonlyArray<ForkableOrchestrationMessage>;
} {
  const compaction = findLatestForkCompaction(input.thread);
  const cutoffMs =
    compaction && Number.isFinite(Date.parse(compaction.compactedAt))
      ? Date.parse(compaction.compactedAt)
      : null;
  const limitIndex =
    input.beforeMessageId !== undefined
      ? input.thread.messages.findIndex((message) => message.id === input.beforeMessageId)
      : input.thread.messages.length;
  const boundedMessages =
    limitIndex >= 0 ? input.thread.messages.slice(0, limitIndex) : input.thread.messages;
  const forkableMessages = boundedMessages.filter(isForkableMessage);
  const history =
    compaction?.startMessageId !== undefined
      ? (() => {
          const startIndex = forkableMessages.findIndex(
            (message) => message.id === compaction.startMessageId,
          );
          return startIndex >= 0 ? forkableMessages.slice(startIndex) : forkableMessages;
        })()
      : forkableMessages.filter((message): message is ForkableOrchestrationMessage => {
          if (cutoffMs === null) {
            return true;
          }
          const messageCreatedAtMs = Date.parse(message.createdAt);
          return Number.isFinite(messageCreatedAtMs) && messageCreatedAtMs >= cutoffMs;
        });

  return {
    compaction,
    history,
  };
}

export function buildForkedOrchestrationMessages(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ForkableOrchestrationMessage>;
  readonly importedAt: string;
}): ReadonlyArray<ForkedOrchestrationMessage> {
  const baseTimestamp = Number.isFinite(Date.parse(input.importedAt))
    ? Date.parse(input.importedAt)
    : Date.now();

  return input.messages.map((message, index) => ({
    messageId: MessageId.makeUnsafe(`fork:${input.threadId}:${index + 1}:${message.role}`),
    role: message.role,
    text: message.text,
    attachments: message.attachments ?? [],
    turnId: message.turnId,
    createdAt: new Date(baseTimestamp + index).toISOString(),
  }));
}

export function buildForkBootstrapPrompt(input: {
  readonly compaction?: ForkBootstrapCompaction | null;
  readonly history: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }>;
  readonly nextUserMessage: string;
  readonly maxChars?: number;
}): string {
  if (input.history.length === 0) {
    if (!input.compaction?.summary) {
      return input.nextUserMessage;
    }
    return `Continue this forked conversation. The original thread compacted its earlier context.\n\n${formatCompactionSummary(input.compaction.summary)}\n\nNew user message:\n${input.nextUserMessage}`;
  }

  const maxChars = input.maxChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  const compactionPrefix = input.compaction?.summary
    ? `${formatCompactionSummary(input.compaction.summary)}\n\n`
    : "";
  const transcriptLabel =
    input.compaction !== null && input.compaction !== undefined
      ? "Transcript after compaction:\n"
      : "Transcript:\n";
  const header = `Continue this forked conversation. The following transcript is prior context from the original thread. Treat it as already-established conversation state.\n\n${compactionPrefix}${transcriptLabel}`;
  const footer = `\n\nNew user message:\n${input.nextUserMessage}`;
  const availableChars = maxChars - header.length - footer.length;
  if (availableChars < FORK_BOOTSTRAP_MIN_TRANSCRIPT_BUDGET) {
    return input.nextUserMessage;
  }

  const formattedEntries = input.history.map(formatTranscriptEntry);
  const keptEntries: string[] = [];
  let usedChars = 0;
  for (let index = formattedEntries.length - 1; index >= 0; index -= 1) {
    const entry = formattedEntries[index]!;
    const separatorLength = keptEntries.length === 0 ? 0 : 4;
    if (usedChars + entry.length + separatorLength > availableChars) {
      break;
    }
    keptEntries.unshift(entry);
    usedChars += entry.length + separatorLength;
  }

  if (keptEntries.length === 0) {
    return input.nextUserMessage;
  }

  while (keptEntries.length > 0) {
    const omittedCount = formattedEntries.length - keptEntries.length;
    const omissionNote =
      omittedCount > 0 ? `[${omittedCount} earlier message(s) omitted for brevity]\n\n` : "";
    const prompt = `${header}${omissionNote}${keptEntries.join("\n\n---\n\n")}${footer}`;
    if (prompt.length <= maxChars) {
      return prompt;
    }
    keptEntries.shift();
  }

  return input.nextUserMessage;
}
