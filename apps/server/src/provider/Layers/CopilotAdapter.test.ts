import { describe, it, assert } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import { getCopilotChunkItemKey } from "./CopilotAdapter";

describe("CopilotAdapter", () => {
  describe("getCopilotChunkItemKey", () => {
    it("reuses the provider message id when one is present", () => {
      const turnId = TurnId.makeUnsafe("turn-copilot-1");
      const key = getCopilotChunkItemKey({
        turnId,
        updateType: "agent_message_chunk",
        messageId: "assistant-message-42",
      });

      assert.strictEqual(key, "assistant-message-42");
    });

    it("falls back to a stable turn-scoped key when the provider omits message ids", () => {
      const turnId = TurnId.makeUnsafe("turn-copilot-2");
      const first = getCopilotChunkItemKey({
        turnId,
        updateType: "agent_message_chunk",
      });
      const second = getCopilotChunkItemKey({
        turnId,
        updateType: "agent_message_chunk",
        messageId: "",
      });

      assert.strictEqual(first, "turn-copilot-2:agent_message_chunk");
      assert.strictEqual(second, first);
    });

    it("keeps assistant and reasoning streams separate within the same turn", () => {
      const turnId = TurnId.makeUnsafe("turn-copilot-3");
      const reasoning = getCopilotChunkItemKey({
        turnId,
        updateType: "agent_thought_chunk",
      });
      const assistant = getCopilotChunkItemKey({
        turnId,
        updateType: "agent_message_chunk",
      });

      assert.notStrictEqual(reasoning, assistant);
    });
  });
});
