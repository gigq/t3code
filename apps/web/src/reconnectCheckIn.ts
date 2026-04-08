import { type ThreadId } from "@t3tools/contracts";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  isLatestTurnSettled,
} from "./session-logic";
import type { WsConnectionUiState } from "./rpc/wsConnectionState";
import type { Thread } from "./types";

const RECONNECT_CHECK_IN_THREAD_IDS_STORAGE_KEY = "t3code:reconnect-checkin-thread-ids";

function hasPendingProviderInteraction(thread: Thread): boolean {
  return (
    derivePendingApprovals(thread.activities).length > 0 ||
    derivePendingUserInputs(thread.activities).length > 0
  );
}

function hasUnfinishedInteractiveTurn(thread: Thread): boolean {
  if (thread.interactionMode === "auto") {
    return false;
  }
  if (!thread.latestTurn?.startedAt || thread.latestTurn.completedAt) {
    return false;
  }
  if (hasPendingProviderInteraction(thread)) {
    return false;
  }
  return true;
}

export function captureReconnectCheckInThreadIds(
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<ThreadId> {
  return threads.filter(hasUnfinishedInteractiveTurn).map((thread) => thread.id);
}

export function shouldDispatchReconnectCheckIn(thread: Thread | undefined): boolean {
  return getReconnectCheckInDisposition(thread) === "dispatch";
}

export function getReconnectCheckInDisposition(
  thread: Thread | undefined,
): "dispatch" | "retry" | "skip" {
  if (!thread) {
    return "retry";
  }
  if (!thread || thread.archivedAt !== null || thread.interactionMode === "auto") {
    return "skip";
  }
  if (hasPendingProviderInteraction(thread)) {
    return "skip";
  }
  if (thread.session?.orchestrationStatus === "running") {
    return "retry";
  }
  if (!thread.latestTurn?.startedAt) {
    return "retry";
  }

  return isLatestTurnSettled(thread.latestTurn, thread.session) ? "skip" : "dispatch";
}

export function shouldScheduleReconnectCheckIn(input: {
  readonly hasPersistedThreadIds: boolean;
  readonly previousDisconnectedAt: string | null;
  readonly previousUiState: WsConnectionUiState;
  readonly uiState: WsConnectionUiState;
}): boolean {
  if (input.uiState !== "connected") {
    return false;
  }

  if (input.hasPersistedThreadIds) {
    return true;
  }

  return (
    (input.previousUiState === "offline" || input.previousUiState === "reconnecting") &&
    input.previousDisconnectedAt !== null
  );
}

export function readPersistedReconnectCheckInThreadIds(
  storage: Storage | null,
): ReadonlyArray<ThreadId> {
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(RECONNECT_CHECK_IN_THREAD_IDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is ThreadId => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function writePersistedReconnectCheckInThreadIds(
  storage: Storage | null,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  if (!storage) {
    return;
  }

  try {
    if (threadIds.length === 0) {
      storage.removeItem(RECONNECT_CHECK_IN_THREAD_IDS_STORAGE_KEY);
      return;
    }

    storage.setItem(RECONNECT_CHECK_IN_THREAD_IDS_STORAGE_KEY, JSON.stringify(threadIds));
  } catch {
    // Ignore storage failures so reconnect handling still proceeds.
  }
}
