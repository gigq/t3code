import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  captureReconnectCheckInThreadIds,
  getReconnectCheckInDisposition,
  readPersistedReconnectCheckInThreadIds,
  shouldScheduleReconnectCheckIn,
  shouldDispatchReconnectCheckIn,
  writePersistedReconnectCheckInThreadIds,
} from "./reconnectCheckIn";
import type { Thread } from "./types";

const NOW = "2026-04-08T20:30:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    autoDeferUntil: null,
    session: {
      provider: "codex",
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: NOW,
      updatedAt: NOW,
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW,
    archivedAt: null,
    updatedAt: NOW,
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      state: "running",
      assistantMessageId: null,
      sourceProposedPlan: undefined,
    },
    pendingSourceProposedPlan: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeActivity(
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe("activity-1"),
    kind: "approval.requested",
    summary: "Pending approval",
    tone: "info",
    createdAt: NOW,
    turnId: null,
    payload: {
      requestId: "approval-1",
      requestKind: "command",
    },
    ...overrides,
  };
}

function createStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    get length() {
      return entries.size;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, value);
    },
  };
}

describe("reconnectCheckIn", () => {
  it("captures unfinished non-auto threads when the socket drops", () => {
    const ids = captureReconnectCheckInThreadIds([
      makeThread(),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        interactionMode: "auto",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-3"),
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          state: "completed",
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
      }),
    ]);

    expect(ids).toEqual([ThreadId.makeUnsafe("thread-1")]);
  });

  it("dispatches a reconnect check-in when the thread is still unfinished after recovery", () => {
    expect(shouldDispatchReconnectCheckIn(makeThread())).toBe(true);
  });

  it("does not dispatch when the thread already finished during recovery", () => {
    expect(
      shouldDispatchReconnectCheckIn(
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            state: "completed",
            assistantMessageId: null,
            sourceProposedPlan: undefined,
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not dispatch when the thread is still actively running after reconnect", () => {
    const thread = makeThread({
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    expect(shouldDispatchReconnectCheckIn(thread)).toBe(false);
    expect(getReconnectCheckInDisposition(thread)).toBe("retry");
  });

  it("does not dispatch when user input or approval is pending", () => {
    expect(
      shouldDispatchReconnectCheckIn(
        makeThread({
          activities: [makeActivity()],
        }),
      ),
    ).toBe(false);
  });

  it("schedules a reconnect check-in after reconnect recovery", () => {
    expect(
      shouldScheduleReconnectCheckIn({
        hasPersistedThreadIds: false,
        previousDisconnectedAt: NOW,
        previousUiState: "reconnecting",
        uiState: "connected",
      }),
    ).toBe(true);
  });

  it("schedules a reconnect check-in after reload when persisted thread ids exist", () => {
    expect(
      shouldScheduleReconnectCheckIn({
        hasPersistedThreadIds: true,
        previousDisconnectedAt: null,
        previousUiState: "connecting",
        uiState: "connected",
      }),
    ).toBe(true);
  });

  it("persists reconnect check-in thread ids in session storage", () => {
    const storage = createStorage();

    writePersistedReconnectCheckInThreadIds(storage, [
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);

    expect(readPersistedReconnectCheckInThreadIds(storage)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);

    writePersistedReconnectCheckInThreadIds(storage, []);

    expect(readPersistedReconnectCheckInThreadIds(storage)).toEqual([]);
  });

  it("retries reconnect check-ins until the thread snapshot is available", () => {
    expect(getReconnectCheckInDisposition(undefined)).toBe("retry");
  });
});
