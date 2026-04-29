import { type ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { readNativeApi } from "../nativeApi";

export function useImportCodexThread() {
  const navigate = useNavigate();

  const importCodexThread = useCallback(
    async (input: {
      readonly projectId: ProjectId;
      readonly providerThreadId: string;
      readonly title?: string;
    }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is unavailable.");
      }

      const result = await api.orchestration.importCodexThread({
        projectId: input.projectId,
        providerThreadId: input.providerThreadId,
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

  const importClaudeThread = useCallback(
    async (input: {
      readonly projectId: ProjectId;
      readonly providerThreadId: string;
      readonly title?: string;
    }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is unavailable.");
      }

      const result = await api.orchestration.importClaudeThread({
        projectId: input.projectId,
        providerThreadId: input.providerThreadId,
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
    importCodexThread,
    importClaudeThread,
  };
}
