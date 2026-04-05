import { describe, expect, it } from "vitest";

import {
  AUTO_MODE_NOOP_SENTINEL,
  isAutoModeHiddenControlMessage,
  parseAutoModeControlMessage,
} from "./autoMode";

describe("autoMode control messages", () => {
  it("parses the noop sentinel", () => {
    expect(parseAutoModeControlMessage(AUTO_MODE_NOOP_SENTINEL)).toEqual({ kind: "noop" });
  });

  it("parses defer presets into timestamps", () => {
    expect(
      parseAutoModeControlMessage(
        '<t3code:auto-defer preset="15m" />',
        new Date("2026-04-05T17:00:00.000Z"),
      ),
    ).toEqual({
      kind: "defer",
      deferUntil: "2026-04-05T17:15:00.000Z",
    });
  });

  it("parses absolute defer timestamps", () => {
    expect(
      parseAutoModeControlMessage(
        '<t3code:auto-defer until="2026-04-06T08:00:00.000Z" />',
        new Date("2026-04-05T17:00:00.000Z"),
      ),
    ).toEqual({
      kind: "defer",
      deferUntil: "2026-04-06T08:00:00.000Z",
    });
  });

  it("recognizes hidden auto control messages", () => {
    expect(isAutoModeHiddenControlMessage(AUTO_MODE_NOOP_SENTINEL)).toBe(true);
    expect(isAutoModeHiddenControlMessage('<t3code:auto-defer preset="1h" />')).toBe(true);
    expect(isAutoModeHiddenControlMessage("normal assistant text")).toBe(false);
  });
});
