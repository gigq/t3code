import { type WsConnectionStatus, getWsConnectionUiState } from "../rpc/wsConnectionState";

export type ConnectionStatusTone = "danger" | "neutral" | "pending" | "success" | "warning";
export type ConnectionStatusIcon = "check" | "loader" | "offline" | "warning";
export type ActiveThreadConnectionState = "error" | "loading" | "missing" | "none" | "ready";

export interface ConnectionStatusIndicatorInput {
  readonly activeThreadState: ActiveThreadConnectionState;
  readonly bootstrapComplete: boolean;
  readonly serverConfigReady: boolean;
  readonly status: WsConnectionStatus;
}

export interface ConnectionStatusIndicatorModel {
  readonly description: string;
  readonly icon: ConnectionStatusIcon;
  readonly label: string;
  readonly tone: ConnectionStatusTone;
}

export function deriveConnectionStatusIndicatorModel(
  input: ConnectionStatusIndicatorInput,
): ConnectionStatusIndicatorModel {
  const uiState = getWsConnectionUiState(input.status);

  if (uiState === "offline") {
    return {
      description: "Browser is offline. Waiting for network before reconnecting to the T3 server.",
      icon: "offline",
      label: "Offline",
      tone: "danger",
    };
  }

  if (uiState === "error" || input.status.reconnectPhase === "exhausted") {
    return {
      description: "Initial connection failed or reconnect retries were exhausted.",
      icon: "warning",
      label: "Disconnected",
      tone: "danger",
    };
  }

  if (uiState === "reconnecting") {
    return {
      description:
        input.status.nextRetryAt === null
          ? "Connection dropped and the client is trying to reconnect now."
          : "Connection dropped and the client is waiting for the next reconnect attempt.",
      icon: "loader",
      label: "Reconnecting",
      tone: "warning",
    };
  }

  if (uiState === "connecting" || !input.serverConfigReady) {
    return {
      description: "WebSocket is opening and waiting for the initial server lifecycle handshake.",
      icon: "loader",
      label: "Connecting",
      tone: "pending",
    };
  }

  if (!input.bootstrapComplete) {
    return {
      description: "Connected to the server and still hydrating projects and thread summaries.",
      icon: "loader",
      label: "Syncing",
      tone: "pending",
    };
  }

  if (input.activeThreadState === "loading") {
    return {
      description: "Connected to the server and loading the active thread detail snapshot.",
      icon: "loader",
      label: "Loading thread",
      tone: "pending",
    };
  }

  if (input.activeThreadState === "error" || input.activeThreadState === "missing") {
    return {
      description:
        input.activeThreadState === "missing"
          ? "The current thread route is active, but the thread is missing from the client store."
          : "The active thread detail request failed and needs recovery.",
      icon: "warning",
      label: "Thread issue",
      tone: "warning",
    };
  }

  return {
    description: "WebSocket is connected and the current app state is hydrated.",
    icon: "check",
    label: "Connected",
    tone: "success",
  };
}
