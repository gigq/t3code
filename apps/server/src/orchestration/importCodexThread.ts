import { MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";

import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";

export interface ImportedThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: TurnId | null;
}

export interface ImportedOrchestrationMessage extends ImportedThreadMessage {
  readonly messageId: MessageId;
  readonly createdAt: string;
}

const IMPORTED_THREAD_TITLE_MAX_CHARS = 72;

function normalizeItemType(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function detectImportedMessageRole(rawType: unknown): ImportedThreadMessage["role"] | null {
  const normalizedType = normalizeItemType(rawType);
  if (normalizedType.includes("user")) {
    return "user";
  }
  if (normalizedType.includes("assistant") || normalizedType.includes("agent message")) {
    return "assistant";
  }
  return null;
}

function extractTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextFragments(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim().length > 0) {
    return [record.text];
  }
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return [record.message];
  }
  if (typeof record.prompt === "string" && record.prompt.trim().length > 0) {
    return [record.prompt];
  }
  if (typeof record.input === "string" && record.input.trim().length > 0) {
    return [record.input];
  }

  const nestedKeys = ["content", "parts", "segments", "items", "output", "value"] as const;
  for (const key of nestedKeys) {
    if (record[key] === undefined) {
      continue;
    }
    const nestedFragments = extractTextFragments(record[key]);
    if (nestedFragments.length > 0) {
      return nestedFragments;
    }
  }

  return [];
}

function normalizeImportedText(fragments: ReadonlyArray<string>): string | null {
  const normalized = fragments
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join("\n\n");
}

export function extractImportedMessagesFromProviderThreadSnapshot(
  snapshot: ProviderThreadSnapshot,
): ImportedThreadMessage[] {
  const messages: ImportedThreadMessage[] = [];

  for (const turn of snapshot.turns) {
    for (const item of turn.items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const role = detectImportedMessageRole(record.type ?? record.kind);
      if (!role) {
        continue;
      }

      const text = normalizeImportedText(
        extractTextFragments(record.content ?? record.parts ?? record.segments ?? record),
      );
      if (!text) {
        continue;
      }

      messages.push({
        role,
        text,
        turnId: role === "assistant" ? turn.id : null,
      });
    }
  }

  return messages;
}

export function buildImportedOrchestrationMessages(input: {
  readonly threadId: ThreadId;
  readonly snapshot: ProviderThreadSnapshot;
  readonly importedAt: string;
}): ImportedOrchestrationMessage[] {
  const baseTimestamp = Number.isFinite(Date.parse(input.importedAt))
    ? Date.parse(input.importedAt)
    : Date.now();

  return extractImportedMessagesFromProviderThreadSnapshot(input.snapshot).map((message, index) => {
    const createdAt = new Date(baseTimestamp + index).toISOString();
    return {
      role: message.role,
      text: message.text,
      turnId: message.turnId,
      messageId: MessageId.makeUnsafe(`import:${input.threadId}:${index + 1}:${message.role}`),
      createdAt,
    };
  });
}

export function buildImportedThreadTitle(
  messages: ReadonlyArray<ImportedThreadMessage>,
  fallbackTitle = "Imported Codex thread",
): string {
  const preferredMessage =
    messages.find((message) => message.role === "user") ??
    messages.find((message) => message.role === "assistant");
  const normalizedTitle = preferredMessage?.text.replace(/\s+/g, " ").trim();
  if (!normalizedTitle) {
    return fallbackTitle;
  }
  if (normalizedTitle.length <= IMPORTED_THREAD_TITLE_MAX_CHARS) {
    return normalizedTitle;
  }
  return `${normalizedTitle.slice(0, IMPORTED_THREAD_TITLE_MAX_CHARS - 3).trimEnd()}...`;
}
