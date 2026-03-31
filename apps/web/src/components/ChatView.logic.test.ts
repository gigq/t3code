import { describe, expect, it } from "vitest";

import { shouldResetSendPhaseFromLatestTurn } from "./ChatView.logic";

describe("shouldResetSendPhaseFromLatestTurn", () => {
  it("does not reset when send phase is idle", () => {
    expect(
      shouldResetSendPhaseFromLatestTurn({
        sendPhase: "idle",
        sendStartedAt: "2026-03-31T16:00:00.000Z",
        latestTurn: {
          startedAt: "2026-03-31T16:00:01.000Z",
          completedAt: "2026-03-31T16:00:05.000Z",
        },
      }),
    ).toBe(false);
  });

  it("does not reset from a turn that completed before the current send began", () => {
    expect(
      shouldResetSendPhaseFromLatestTurn({
        sendPhase: "sending-turn",
        sendStartedAt: "2026-03-31T16:00:10.000Z",
        latestTurn: {
          startedAt: "2026-03-31T16:00:01.000Z",
          completedAt: "2026-03-31T16:00:05.000Z",
        },
      }),
    ).toBe(false);
  });

  it("resets once the latest turn both starts and completes after the send began", () => {
    expect(
      shouldResetSendPhaseFromLatestTurn({
        sendPhase: "sending-turn",
        sendStartedAt: "2026-03-31T16:00:10.000Z",
        latestTurn: {
          startedAt: "2026-03-31T16:00:11.000Z",
          completedAt: "2026-03-31T16:00:15.000Z",
        },
      }),
    ).toBe(true);
  });
});
