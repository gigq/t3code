import { describe, expect, it } from "vitest";

import { buildReconnectCheckInPrompt } from "./reconnectCheckIn";

describe("reconnectCheckIn", () => {
  it("builds a hidden reconnect prompt", () => {
    const prompt = buildReconnectCheckInPrompt("2026-04-08T20:20:00.000Z");

    expect(prompt).toContain("<reconnect_checkin>");
    expect(prompt).toContain("2026-04-08T20:20:00.000Z");
    expect(prompt).toContain("continue it now and finish your thought");
    expect(prompt).toContain("</reconnect_checkin>");
  });
});
