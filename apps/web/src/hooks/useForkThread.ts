import { type MessageId, type ModelSelection, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { readNativeApi } from "../nativeApi";
import { type Thread } from "../types";

export function useForkThread() {
  const navigate = useNavigate();

  const forkThread = useCallback(
    async (input: {
      readonly sourceThreadId: ThreadId;
      readonly sourceMessageId?: MessageId;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: Thread["runtimeMode"];
      readonly interactionMode: Thread["interactionMode"];
      readonly title?: string;
    }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is unavailable.");
      }

      const result = await api.orchestration.forkThread({
        sourceThreadId: input.sourceThreadId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        ...(input.title ? { title: input.title } : {}),
      });

      await navigate({
        to: "/$threadId",
        params: { threadId: result.threadId },
      });

      return result.threadId;
    },
    [navigate],
  );

  return {
    forkThread,
  };
}
