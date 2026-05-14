import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings";

it("decodes Claude PTY provider settings with disabled-by-default values", () => {
  const settings = Schema.decodeSync(ServerSettings)({});

  assert.deepStrictEqual(settings.providers.claudePty, {
    enabled: false,
    binaryPath: "claude",
    customModels: [],
  });
});

it("accepts Claude PTY provider settings patches", () => {
  const patch = Schema.decodeSync(ServerSettingsPatch)({
    providers: {
      claudePty: {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        customModels: ["claude-custom"],
      },
    },
  });

  assert.deepStrictEqual(patch.providers?.claudePty, {
    enabled: true,
    binaryPath: "/opt/homebrew/bin/claude",
    customModels: ["claude-custom"],
  });
});
