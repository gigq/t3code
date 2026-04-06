import { describe, expect, it } from "vitest";

import { shouldResetInteractionModeDraftOverride } from "./interactionMode";

describe("shouldResetInteractionModeDraftOverride", () => {
  it("resets a stale persisted draft override when the first server snapshot disagrees", () => {
    expect(
      shouldResetInteractionModeDraftOverride({
        draftInteractionMode: "auto",
        previousServerInteractionMode: null,
        nextServerInteractionMode: "default",
      }),
    ).toBe(true);
  });

  it("keeps a persisted draft override when the first server snapshot matches it", () => {
    expect(
      shouldResetInteractionModeDraftOverride({
        draftInteractionMode: "auto",
        previousServerInteractionMode: null,
        nextServerInteractionMode: "auto",
      }),
    ).toBe(false);
  });

  it("resets a draft override that was only mirroring the previous server mode", () => {
    expect(
      shouldResetInteractionModeDraftOverride({
        draftInteractionMode: "auto",
        previousServerInteractionMode: "auto",
        nextServerInteractionMode: "default",
      }),
    ).toBe(true);
  });

  it("keeps an explicit user-selected override when the server catches up", () => {
    expect(
      shouldResetInteractionModeDraftOverride({
        draftInteractionMode: "auto",
        previousServerInteractionMode: "default",
        nextServerInteractionMode: "auto",
      }),
    ).toBe(false);
  });

  it("does not reset when there is no draft override", () => {
    expect(
      shouldResetInteractionModeDraftOverride({
        draftInteractionMode: null,
        previousServerInteractionMode: "auto",
        nextServerInteractionMode: "default",
      }),
    ).toBe(false);
  });
});
