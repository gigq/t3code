import { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { DEFAULT_THREAD_DEBUG_HEIGHT } from "./types";

interface ThreadDebugState {
  debugOpen: boolean;
  debugHeight: number;
}

interface ThreadDebugStoreState {
  debugStateByThreadId: Record<ThreadId, ThreadDebugState>;
  setDebugOpen: (threadId: ThreadId, open: boolean) => void;
  setDebugHeight: (threadId: ThreadId, height: number) => void;
  removeOrphanedDebugStates: (activeThreadIds: Set<ThreadId>) => void;
}

const THREAD_DEBUG_STATE_STORAGE_KEY = "t3code:thread-debug-state:v1";

const DEFAULT_THREAD_DEBUG_STATE: ThreadDebugState = Object.freeze({
  debugOpen: false,
  debugHeight: DEFAULT_THREAD_DEBUG_HEIGHT,
});

function createThreadDebugStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeThreadDebugState(state: ThreadDebugState): ThreadDebugState {
  return {
    debugOpen: state.debugOpen === true,
    debugHeight:
      Number.isFinite(state.debugHeight) && state.debugHeight > 0
        ? state.debugHeight
        : DEFAULT_THREAD_DEBUG_HEIGHT,
  };
}

function selectThreadDebugState(
  debugStateByThreadId: Record<ThreadId, ThreadDebugState>,
  threadId: ThreadId,
): ThreadDebugState {
  if (threadId.length === 0) {
    return DEFAULT_THREAD_DEBUG_STATE;
  }
  return debugStateByThreadId[threadId] ?? DEFAULT_THREAD_DEBUG_STATE;
}

function updateDebugStateByThreadId(
  debugStateByThreadId: Record<ThreadId, ThreadDebugState>,
  threadId: ThreadId,
  updater: (state: ThreadDebugState) => ThreadDebugState,
): Record<ThreadId, ThreadDebugState> {
  if (threadId.length === 0) {
    return debugStateByThreadId;
  }

  const current = selectThreadDebugState(debugStateByThreadId, threadId);
  const next = normalizeThreadDebugState(updater(current));
  if (current.debugOpen === next.debugOpen && current.debugHeight === next.debugHeight) {
    return debugStateByThreadId;
  }

  if (!next.debugOpen && next.debugHeight === DEFAULT_THREAD_DEBUG_HEIGHT) {
    if (debugStateByThreadId[threadId] === undefined) {
      return debugStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = debugStateByThreadId;
    return rest as Record<ThreadId, ThreadDebugState>;
  }

  return {
    ...debugStateByThreadId,
    [threadId]: next,
  };
}

export const useThreadDebugStateStore = create<ThreadDebugStoreState>()(
  persist(
    (set) => ({
      debugStateByThreadId: {},
      setDebugOpen: (threadId, open) =>
        set((state) => ({
          debugStateByThreadId: updateDebugStateByThreadId(
            state.debugStateByThreadId,
            threadId,
            (current) => ({ ...current, debugOpen: open }),
          ),
        })),
      setDebugHeight: (threadId, height) =>
        set((state) => ({
          debugStateByThreadId: updateDebugStateByThreadId(
            state.debugStateByThreadId,
            threadId,
            (current) => ({ ...current, debugHeight: height }),
          ),
        })),
      removeOrphanedDebugStates: (activeThreadIds) =>
        set((state) => {
          const orphanedThreadIds = Object.keys(state.debugStateByThreadId).filter(
            (threadId) => !activeThreadIds.has(ThreadId.makeUnsafe(threadId)),
          ) as ThreadId[];
          if (orphanedThreadIds.length === 0) {
            return state;
          }

          const next = { ...state.debugStateByThreadId };
          for (const threadId of orphanedThreadIds) {
            delete next[threadId];
          }
          return {
            debugStateByThreadId: next,
          };
        }),
    }),
    {
      name: THREAD_DEBUG_STATE_STORAGE_KEY,
      storage: createJSONStorage(createThreadDebugStateStorage),
      partialize: (state) => ({
        debugStateByThreadId: state.debugStateByThreadId,
      }),
    },
  ),
);

export { selectThreadDebugState };
