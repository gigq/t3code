import { describe, expect, it } from "vitest";

import {
  buildAutoModeTickPrompt,
  AUTO_MODE_NOOP_SENTINEL,
  AUTO_MODE_STOP_SENTINEL,
  isAutoModeHiddenControlMessage,
  isAutoModeHiddenMessage,
  isAutoModeTickPromptMessage,
  parseAutoModeControlMessage,
} from "./autoMode";

describe("autoMode control messages", () => {
  it("parses the noop sentinel", () => {
    expect(parseAutoModeControlMessage(AUTO_MODE_NOOP_SENTINEL)).toEqual({ kind: "noop" });
  });

  it("parses the stop sentinel", () => {
    expect(parseAutoModeControlMessage(AUTO_MODE_STOP_SENTINEL)).toEqual({ kind: "stop" });
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
    expect(isAutoModeHiddenControlMessage(AUTO_MODE_STOP_SENTINEL)).toBe(true);
    expect(isAutoModeHiddenControlMessage("normal assistant text")).toBe(false);
  });

  it("recognizes leaked auto tick prompts as hidden messages", () => {
    const tickPrompt = buildAutoModeTickPrompt("2026-04-06T01:13:25.697Z");
    expect(isAutoModeTickPromptMessage(tickPrompt)).toBe(true);
    expect(isAutoModeHiddenMessage(tickPrompt)).toBe(true);
    expect(isAutoModeHiddenMessage(AUTO_MODE_NOOP_SENTINEL)).toBe(true);
    expect(tickPrompt).toContain(AUTO_MODE_STOP_SENTINEL);
    expect(tickPrompt).toContain(
      "If the thread already has an accepted plan or an obvious in-progress checklist, keep executing it until the plan is complete or you are truly blocked.",
    );
    expect(tickPrompt).toContain(
      "Do not stop merely because you finished one step if the remaining planned work is still actionable.",
    );
    expect(isAutoModeHiddenMessage("normal assistant text")).toBe(false);
  });
});
