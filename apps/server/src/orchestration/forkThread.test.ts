import { MessageId, ThreadId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildForkBootstrapPrompt,
  buildForkedOrchestrationMessages,
  buildForkedThreadTitle,
  findLatestForkCompaction,
  isImportedForkMessage,
  isImportedForkMessageId,
  selectForkBootstrapMessages,
  selectForkableMessages,
  shouldBootstrapForkHistory,
} from "./forkThread.ts";

describe("forkThread helpers", () => {
  it("selects only completed user and assistant messages for import", () => {
    const turnId = TurnId.makeUnsafe("turn-source");
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.makeUnsafe("message-system"),
        role: "system",
        text: "internal note",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:00.000Z",
        updatedAt: "2026-04-12T01:00:00.000Z",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("message-user"),
        role: "user",
        text: "Review this thread",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:01.000Z",
        updatedAt: "2026-04-12T01:00:01.000Z",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("message-streaming"),
        role: "assistant",
        text: "partial",
        streaming: true,
        attachments: [],
        createdAt: "2026-04-12T01:00:02.000Z",
        updatedAt: "2026-04-12T01:00:02.000Z",
        turnId,
      },
      {
        id: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "Here is the completed answer.",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:03.000Z",
        updatedAt: "2026-04-12T01:00:03.000Z",
        turnId,
      },
    ];
    const thread = {
      messages,
    };

    expect(selectForkableMessages(thread)).toEqual([
      {
        id: MessageId.makeUnsafe("message-user"),
        role: "user",
        text: "Review this thread",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:01.000Z",
        updatedAt: "2026-04-12T01:00:01.000Z",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "Here is the completed answer.",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:03.000Z",
        updatedAt: "2026-04-12T01:00:03.000Z",
        turnId,
      },
    ]);
  });

  it("builds stable imported messages and a bootstrap prompt", () => {
    const threadId = ThreadId.makeUnsafe("thread-fork");
    const turnId = TurnId.makeUnsafe("turn-source");
    const sourceMessages: OrchestrationMessage[] = [
      {
        id: MessageId.makeUnsafe("message-user"),
        role: "user",
        text: "Review this thread",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:01.000Z",
        updatedAt: "2026-04-12T01:00:01.000Z",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "Here is the completed answer.",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:03.000Z",
        updatedAt: "2026-04-12T01:00:03.000Z",
        turnId,
      },
    ];
    const messages = selectForkableMessages({ messages: sourceMessages });

    expect(
      buildForkedOrchestrationMessages({
        threadId,
        messages,
        importedAt: "2026-04-12T02:00:00.000Z",
      }),
    ).toEqual([
      {
        messageId: "fork:thread-fork:1:user",
        role: "user",
        text: "Review this thread",
        attachments: [],
        turnId: null,
        createdAt: "2026-04-12T02:00:00.000Z",
      },
      {
        messageId: "fork:thread-fork:2:assistant",
        role: "assistant",
        text: "Here is the completed answer.",
        attachments: [],
        turnId,
        createdAt: "2026-04-12T02:00:00.001Z",
      },
    ]);

    expect(buildForkedThreadTitle("Investigate provider reconnect handling")).toBe(
      "Investigate provider reconnect handling (fork)",
    );

    expect(
      buildForkBootstrapPrompt({
        history: messages.map((message) => ({
          role: message.role,
          text: message.text,
        })),
        nextUserMessage: "Try this with Claude instead.",
      }),
    ).toContain("New user message:\nTry this with Claude instead.");
  });

  it("uses the latest compaction boundary and summary for bootstrap", () => {
    const turnId = TurnId.makeUnsafe("turn-source");
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.makeUnsafe("message-before"),
        role: "user",
        text: "Old context before compaction",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:00:01.000Z",
        updatedAt: "2026-04-12T01:00:01.000Z",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("message-after-user"),
        role: "user",
        text: "Follow-up after compaction",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:10:01.000Z",
        updatedAt: "2026-04-12T01:10:01.000Z",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("message-after-assistant"),
        role: "assistant",
        text: "Answer after compaction",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:10:05.000Z",
        updatedAt: "2026-04-12T01:10:05.000Z",
        turnId,
      },
      {
        id: MessageId.makeUnsafe("message-next"),
        role: "user",
        text: "Use a different provider now",
        streaming: false,
        attachments: [],
        createdAt: "2026-04-12T01:10:10.000Z",
        updatedAt: "2026-04-12T01:10:10.000Z",
        turnId: null,
      },
    ];
    const thread = {
      messages,
      activities: [
        {
          id: "activity-old" as never,
          tone: "info" as const,
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            detail: "Very old compaction summary",
          },
          turnId: null,
          createdAt: "2026-04-12T01:05:00.000Z",
        },
        {
          id: "activity-latest" as never,
          tone: "info" as const,
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            detail: "Latest compacted summary",
          },
          turnId: null,
          createdAt: "2026-04-12T01:09:00.000Z",
        },
      ],
    };

    expect(findLatestForkCompaction(thread)).toEqual({
      compactedAt: "2026-04-12T01:09:00.000Z",
      summary: "Latest compacted summary",
    });

    const bootstrap = selectForkBootstrapMessages({
      thread,
      beforeMessageId: MessageId.makeUnsafe("message-next"),
    });

    expect(bootstrap.compaction).toEqual({
      compactedAt: "2026-04-12T01:09:00.000Z",
      summary: "Latest compacted summary",
    });
    expect(bootstrap.history.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-after-user"),
      MessageId.makeUnsafe("message-after-assistant"),
    ]);

    const prompt = buildForkBootstrapPrompt({
      compaction: bootstrap.compaction,
      history: bootstrap.history.map((message) => ({
        role: message.role,
        text: message.text,
      })),
      nextUserMessage: "Use a different provider now",
    });

    expect(prompt).toContain("Compaction summary:\nLatest compacted summary");
    expect(prompt).toContain("Transcript after compaction:");
    expect(prompt).not.toContain("Old context before compaction");
    expect(prompt).toContain("Follow-up after compaction");
    expect(prompt).toContain("Answer after compaction");
  });

  it("prefers an explicit imported-message compaction boundary over timestamps", () => {
    const importedThreadId = ThreadId.makeUnsafe("thread-fork");
    const importedMessages = buildForkedOrchestrationMessages({
      threadId: importedThreadId,
      importedAt: "2026-04-12T02:00:00.000Z",
      messages: [
        {
          id: MessageId.makeUnsafe("source-before"),
          role: "user",
          text: "Old context before compaction",
          streaming: false,
          attachments: [],
          createdAt: "2026-04-12T01:00:00.000Z",
          updatedAt: "2026-04-12T01:00:00.000Z",
          turnId: null,
        },
        {
          id: MessageId.makeUnsafe("source-after-user"),
          role: "user",
          text: "Follow-up after compaction",
          streaming: false,
          attachments: [],
          createdAt: "2026-04-12T01:10:00.000Z",
          updatedAt: "2026-04-12T01:10:00.000Z",
          turnId: null,
        },
        {
          id: MessageId.makeUnsafe("source-after-assistant"),
          role: "assistant",
          text: "Answer after compaction",
          streaming: false,
          attachments: [],
          createdAt: "2026-04-12T01:10:01.000Z",
          updatedAt: "2026-04-12T01:10:01.000Z",
          turnId: TurnId.makeUnsafe("turn-source-after"),
        },
      ],
    }).map((message) => ({
      id: message.messageId,
      role: message.role,
      text: message.text,
      streaming: false,
      attachments: [...message.attachments],
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      turnId: message.turnId,
    })) as OrchestrationMessage[];

    const bootstrap = selectForkBootstrapMessages({
      thread: {
        messages: importedMessages,
        activities: [
          {
            id: "activity-imported-boundary" as never,
            tone: "info" as const,
            kind: "context-compaction",
            summary: "Context compacted",
            payload: {
              detail: "Source thread context was compacted before this fork.",
              forkBootstrapStartMessageId: importedMessages[1]?.id,
            },
            turnId: null,
            createdAt: "2026-04-12T02:00:00.500Z",
          },
        ],
      },
    });

    expect(bootstrap.history.map((message) => message.id)).toEqual([
      importedMessages[1]?.id,
      importedMessages[2]?.id,
    ]);
    expect(bootstrap.compaction?.startMessageId).toBe(importedMessages[1]?.id);
  });

  it("keeps the bootstrap prompt within the provider send-turn limit", () => {
    const prompt = buildForkBootstrapPrompt({
      history: Array.from({ length: 40 }, (_, index) => ({
        role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        text: `Message ${index + 1}: ${"x".repeat(120)}`,
      })),
      nextUserMessage: "Continue from here",
      maxChars: 600,
    });

    expect(prompt.length).toBeLessThanOrEqual(600);
    expect(
      prompt === "Continue from here" || prompt.includes("New user message:\nContinue from here"),
    ).toBe(true);
  });

  it("bootstraps only the first live turn after imported fork history", () => {
    const importedThreadId = ThreadId.makeUnsafe("thread-fork");
    const importedMessages = buildForkedOrchestrationMessages({
      threadId: importedThreadId,
      importedAt: "2026-04-12T02:00:00.000Z",
      messages: [
        {
          id: MessageId.makeUnsafe("source-user"),
          role: "user",
          text: "Earlier user request",
          streaming: false,
          attachments: [],
          createdAt: "2026-04-12T01:00:00.000Z",
          updatedAt: "2026-04-12T01:00:00.000Z",
          turnId: null,
        },
        {
          id: MessageId.makeUnsafe("source-assistant"),
          role: "assistant",
          text: "Earlier assistant answer",
          streaming: false,
          attachments: [],
          createdAt: "2026-04-12T01:00:01.000Z",
          updatedAt: "2026-04-12T01:00:01.000Z",
          turnId: TurnId.makeUnsafe("source-turn"),
        },
      ],
    });
    const importedThreadMessages: OrchestrationMessage[] = importedMessages.map((message) => ({
      id: message.messageId,
      role: message.role,
      text: message.text,
      streaming: false,
      attachments: [...message.attachments],
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      turnId: message.turnId,
    }));
    const firstLiveMessage: OrchestrationMessage = {
      id: MessageId.makeUnsafe("message-live-1"),
      role: "user",
      text: "Can Claude continue this?",
      streaming: false,
      attachments: [],
      createdAt: "2026-04-12T02:00:01.000Z",
      updatedAt: "2026-04-12T02:00:01.000Z",
      turnId: null,
    };
    const pendingUserMessage: OrchestrationMessage = {
      id: MessageId.makeUnsafe("message-pending-user"),
      role: "user",
      text: "Can you see the previous history in this thread",
      streaming: false,
      attachments: [],
      createdAt: "2026-04-12T02:00:01.500Z",
      updatedAt: "2026-04-12T02:00:01.500Z",
      turnId: null,
    };
    const firstLiveAssistantMessage: OrchestrationMessage = {
      id: MessageId.makeUnsafe("message-live-assistant"),
      role: "assistant",
      text: "I can see the forked transcript.",
      streaming: false,
      attachments: [],
      createdAt: "2026-04-12T02:00:01.800Z",
      updatedAt: "2026-04-12T02:00:01.800Z",
      turnId: TurnId.makeUnsafe("turn-live-1"),
    };
    const secondLiveMessage: OrchestrationMessage = {
      id: MessageId.makeUnsafe("message-live-2"),
      role: "user",
      text: "What about the bounce logs?",
      streaming: false,
      attachments: [],
      createdAt: "2026-04-12T02:00:02.000Z",
      updatedAt: "2026-04-12T02:00:02.000Z",
      turnId: null,
    };

    expect(importedMessages.every((message) => isImportedForkMessageId(message.messageId))).toBe(
      true,
    );
    expect(
      isImportedForkMessage({
        id: MessageId.makeUnsafe("fork:thread-fork:99:user"),
      } as OrchestrationMessage),
    ).toBe(true);

    expect(
      shouldBootstrapForkHistory({
        thread: {
          messages: [...importedThreadMessages, pendingUserMessage, firstLiveMessage],
        },
        beforeMessageId: firstLiveMessage.id,
      }),
    ).toBe(true);

    expect(
      shouldBootstrapForkHistory({
        thread: {
          messages: [
            ...importedThreadMessages,
            pendingUserMessage,
            firstLiveAssistantMessage,
            secondLiveMessage,
          ],
        },
        beforeMessageId: secondLiveMessage.id,
      }),
    ).toBe(false);
  });
});
