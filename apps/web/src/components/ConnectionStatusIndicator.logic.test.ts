import { describe, expect, it } from "vitest";

import {
  deriveConnectionStatusIndicatorModel,
  type ConnectionStatusIndicatorInput,
} from "./ConnectionStatusIndicator.logic";

const baseInput: ConnectionStatusIndicatorInput = {
  activeThreadState: "ready",
  bootstrapComplete: true,
  serverConfigReady: true,
  status: {
    attemptCount: 1,
    closeCode: null,
    closeReason: null,
    connectedAt: "2026-04-11T01:00:00.000Z",
    disconnectedAt: null,
    hasConnected: true,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "connected",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: "ws://127.0.0.1:3773/ws",
  },
};

describe("ConnectionStatusIndicator.logic", () => {
  it("shows connected when websocket and hydration are healthy", () => {
    expect(deriveConnectionStatusIndicatorModel(baseInput)).toMatchObject({
      icon: "check",
      label: "Connected",
      tone: "success",
    });
  });

  it("shows syncing while bootstrap is incomplete", () => {
    expect(
      deriveConnectionStatusIndicatorModel({
        ...baseInput,
        bootstrapComplete: false,
      }),
    ).toMatchObject({
      icon: "loader",
      label: "Syncing",
      tone: "pending",
    });
  });

  it("shows loading thread when the active thread detail is still pending", () => {
    expect(
      deriveConnectionStatusIndicatorModel({
        ...baseInput,
        activeThreadState: "loading",
      }),
    ).toMatchObject({
      icon: "loader",
      label: "Loading thread",
      tone: "pending",
    });
  });

  it("shows reconnecting while waiting for retry", () => {
    expect(
      deriveConnectionStatusIndicatorModel({
        ...baseInput,
        status: {
          ...baseInput.status,
          disconnectedAt: "2026-04-11T01:01:00.000Z",
          nextRetryAt: "2026-04-11T01:01:05.000Z",
          phase: "disconnected",
          reconnectAttemptCount: 2,
          reconnectPhase: "waiting",
        },
      }),
    ).toMatchObject({
      icon: "loader",
      label: "Reconnecting",
      tone: "warning",
    });
  });

  it("shows offline when the browser is offline", () => {
    expect(
      deriveConnectionStatusIndicatorModel({
        ...baseInput,
        status: {
          ...baseInput.status,
          disconnectedAt: "2026-04-11T01:01:00.000Z",
          online: false,
          phase: "disconnected",
          reconnectPhase: "waiting",
        },
      }),
    ).toMatchObject({
      icon: "offline",
      label: "Offline",
      tone: "danger",
    });
  });

  it("shows a thread issue for a missing active thread route after bootstrap", () => {
    expect(
      deriveConnectionStatusIndicatorModel({
        ...baseInput,
        activeThreadState: "missing",
      }),
    ).toMatchObject({
      icon: "warning",
      label: "Thread issue",
      tone: "warning",
    });
  });
});
