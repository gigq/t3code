import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildImportedOrchestrationMessages,
  buildImportedThreadTitle,
  extractImportedMessagesFromProviderThreadSnapshot,
} from "./importCodexThread.ts";

describe("importCodexThread helpers", () => {
  it("extracts user and assistant messages from provider thread snapshots", () => {
    const snapshot = {
      threadId: ThreadId.makeUnsafe("thread-import"),
      turns: [
        {
          id: TurnId.makeUnsafe("turn-1"),
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: "Investigate the failing build" }],
            },
            {
              type: "assistantMessage",
              content: [{ type: "text", text: "I found two failing test files." }],
            },
            {
              type: "commandExecution",
              content: [{ type: "text", text: "bun test" }],
            },
          ],
        },
      ],
    };

    expect(extractImportedMessagesFromProviderThreadSnapshot(snapshot)).toEqual([
      {
        role: "user",
        text: "Investigate the failing build",
        turnId: null,
      },
      {
        role: "assistant",
        text: "I found two failing test files.",
        turnId: TurnId.makeUnsafe("turn-1"),
      },
    ]);
  });

  it("builds stable imported orchestration messages and a fallback title", () => {
    const threadId = ThreadId.makeUnsafe("thread-import");
    const snapshot = {
      threadId,
      turns: [
        {
          id: TurnId.makeUnsafe("turn-1"),
          items: [
            {
              type: "assistantMessage",
              parts: [{ text: "Recovered prior session context" }],
            },
          ],
        },
      ],
    };

    expect(
      buildImportedOrchestrationMessages({
        threadId,
        snapshot,
        importedAt: "2026-03-30T12:00:00.000Z",
      }),
    ).toEqual([
      {
        messageId: "import:thread-import:1:assistant",
        role: "assistant",
        text: "Recovered prior session context",
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-03-30T12:00:00.000Z",
      },
    ]);

    expect(buildImportedThreadTitle([], "Imported Codex thread")).toBe("Imported Codex thread");
    expect(
      buildImportedThreadTitle([
        {
          role: "assistant",
          text: "Recovered prior session context",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
      ]),
    ).toBe("Recovered prior session context");
  });
});
