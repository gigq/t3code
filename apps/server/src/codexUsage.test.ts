import { describe, expect, it } from "vitest";
import { normalizeCodexbarUsagePayload, parseCodexStatusText } from "./codexUsage";

describe("normalizeCodexbarUsagePayload", () => {
  it("normalizes codexbar array payloads", () => {
    const result = normalizeCodexbarUsagePayload([
      {
        provider: "codex",
        usage: {
          updatedAt: "2026-04-03T13:50:25Z",
          accountEmail: "justin@gigq.com",
          loginMethod: "pro",
          primary: {
            windowMinutes: 300,
            usedPercent: 1,
            resetsAt: "2026-04-03T18:46:24Z",
            resetDescription: "1:46 PM",
          },
          secondary: {
            windowMinutes: 10080,
            usedPercent: 11,
            resetsAt: "2026-04-08T18:19:34Z",
            resetDescription: "8 Apr 2026 at 1:19 PM",
          },
          identity: {
            accountEmail: "justin@gigq.com",
            loginMethod: "pro",
          },
        },
        source: "codex-cli",
        version: "0.117.0",
        credits: {
          remaining: 0,
          updatedAt: "2026-04-03T13:50:26Z",
        },
      },
    ]);

    expect(result).toEqual({
      available: true,
      provider: "codex",
      accountEmail: "justin@gigq.com",
      loginMethod: "pro",
      source: "codex-cli",
      version: "0.117.0",
      primary: {
        windowMinutes: 300,
        usedPercent: 1,
        leftPercent: 99,
        resetsAt: "2026-04-03T18:46:24Z",
        resetDescription: "1:46 PM",
      },
      secondary: {
        windowMinutes: 10080,
        usedPercent: 11,
        leftPercent: 89,
        resetsAt: "2026-04-08T18:19:34Z",
        resetDescription: "8 Apr 2026 at 1:19 PM",
      },
      sparkPrimary: null,
      sparkSecondary: null,
      creditsRemaining: 0,
      updatedAt: "2026-04-03T13:50:25Z",
      error: null,
    });
  });

  it("returns an unavailable result when the primary window is missing", () => {
    const result = normalizeCodexbarUsagePayload({
      provider: "codex",
      usage: {
        secondary: {
          windowMinutes: 10080,
          usedPercent: 11,
        },
      },
    });

    expect(result.available).toBe(false);
    expect(result.error).toBe("Primary Codex usage window is missing.");
    expect(result.primary).toBeNull();
    expect(result.secondary?.leftPercent).toBe(89);
    expect(result.sparkPrimary).toBeNull();
    expect(result.sparkSecondary).toBeNull();
  });

  it("returns an unavailable result for invalid payloads", () => {
    const result = normalizeCodexbarUsagePayload("bogus");

    expect(result.available).toBe(false);
    expect(result.error).toBe("Codex usage returned invalid JSON.");
    expect(result.sparkPrimary).toBeNull();
    expect(result.sparkSecondary).toBeNull();
  });
});

describe("parseCodexStatusText", () => {
  it("parses wrapped primary and spark limits from codex /status", () => {
    const result = parseCodexStatusText(`
      │  5h limit:                    [████████████████████] 98% left (resets 13:46) │
      │  Weekly limit:                [██████████████████░░] 89% left                │
      │                               (resets 13:19 on 8 Apr)                        │
      │  GPT-5.3-Codex-Spark limit:                                                  │
      │  5h limit:                    [████████████████████] 98% left (resets 14:09) │
      │  Weekly limit:                [███████████████████░] 97% left                │
      │                               (resets 00:00 on 7 Apr)                        │
    `);

    expect(result).toEqual({
      primary: {
        windowMinutes: 300,
        usedPercent: 2,
        leftPercent: 98,
        resetsAt: null,
        resetDescription: "13:46",
      },
      secondary: {
        windowMinutes: 10080,
        usedPercent: 11,
        leftPercent: 89,
        resetsAt: null,
        resetDescription: "13:19 on 8 Apr",
      },
      sparkPrimary: {
        windowMinutes: 300,
        usedPercent: 2,
        leftPercent: 98,
        resetsAt: null,
        resetDescription: "14:09",
      },
      sparkSecondary: {
        windowMinutes: 10080,
        usedPercent: 3,
        leftPercent: 97,
        resetsAt: null,
        resetDescription: "00:00 on 7 Apr",
      },
    });
  });
});
