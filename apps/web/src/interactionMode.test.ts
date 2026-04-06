import { describe, expect, it } from "vitest";

import { shouldResetInteractionModeDraftOverride } from "./interactionMode";

describe("shouldResetInteractionModeDraftOverride", () => {
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
