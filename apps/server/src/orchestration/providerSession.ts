import type { OrchestrationSession, ProviderSession, ThreadId } from "@t3tools/contracts";

export function mapProviderSessionStatusToOrchestrationStatus(
  status: ProviderSession["status"],
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export function toOrchestrationSession(input: {
  readonly threadId: ThreadId;
  readonly session: ProviderSession;
}): OrchestrationSession {
  return {
    threadId: input.threadId,
    status: mapProviderSessionStatusToOrchestrationStatus(input.session.status),
    providerName: input.session.provider,
    runtimeMode: input.session.runtimeMode,
    activeTurnId: null,
    lastError: input.session.lastError ?? null,
    updatedAt: input.session.updatedAt,
  };
}
