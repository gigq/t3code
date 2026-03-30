import { describe, expect, it } from "vitest";

import { extractCodexThreadId } from "./codex";

describe("extractCodexThreadId", () => {
  it("returns an exact Codex thread id unchanged except for casing", () => {
    expect(extractCodexThreadId("019D1C3B-3D2A-7FB0-BCA8-1290528DED4A")).toBe(
      "019d1c3b-3d2a-7fb0-bca8-1290528ded4a",
    );
  });

  it("accepts urn-prefixed ids", () => {
    expect(extractCodexThreadId("urn:uuid:019d1c3b-3d2a-7fb0-bca8-1290528ded4a")).toBe(
      "019d1c3b-3d2a-7fb0-bca8-1290528ded4a",
    );
  });

  it("extracts an id from pasted session text", () => {
    expect(
      extractCodexThreadId(
        "polymaker project: 019d1c3b-3d2a-7fb0-bca8-1290528ded4a /home/justin/git/gigq/polymaker",
      ),
    ).toBe("019d1c3b-3d2a-7fb0-bca8-1290528ded4a");
  });

  it("extracts a valid id when trailing characters are pasted accidentally", () => {
    expect(extractCodexThreadId("019d1c3b-3d2a-7fb0-bca8-1290528ded4aR")).toBe(
      "019d1c3b-3d2a-7fb0-bca8-1290528ded4a",
    );
  });

  it("returns null when no Codex thread id is present", () => {
    expect(extractCodexThreadId("not a codex id")).toBeNull();
  });
});
