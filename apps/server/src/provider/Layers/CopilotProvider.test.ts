import { describe, it, assert } from "@effect/vitest";

import {
  buildCopilotBuiltInModels,
  formatCopilotModelDisplayName,
  parseCopilotBundledModelSlugsFromSource,
} from "../copilotCliModels";

const EMPTY_MODEL_CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} as const;

describe("CopilotProvider", () => {
  describe("parseCopilotBundledModelSlugsFromSource", () => {
    it("extracts visible bundled models from the installed CLI source pattern", () => {
      const source =
        'var pY=["claude-sonnet-4.6","claude-opus-4.6-fast","claude-opus-4.6-1m","gpt-5.4","gpt-5-mini"],fKt=new Set(["claude-opus-4.6-1m"]),yKt=pY.filter(t=>!fKt.has(t));';

      const parsed = parseCopilotBundledModelSlugsFromSource(source);

      assert.deepStrictEqual(parsed, [
        "claude-sonnet-4.6",
        "claude-opus-4.6-fast",
        "gpt-5.4",
        "gpt-5-mini",
      ]);
    });
  });

  describe("buildCopilotBuiltInModels", () => {
    it("falls back to the bundled default model catalog when the CLI bundle cannot be read", () => {
      const models = buildCopilotBuiltInModels(
        "/definitely-missing/copilot",
        EMPTY_MODEL_CAPABILITIES,
      );

      assert.strictEqual(models[0]?.slug, "default");
      assert.strictEqual(models[0]?.name, "Default");
      assert.strictEqual(
        models.some((model) => model.slug === "gpt-5.4"),
        true,
      );
      assert.strictEqual(
        models.some((model) => model.slug === "claude-sonnet-4.6"),
        true,
      );
    });

    it("formats known Copilot model display names for the picker", () => {
      assert.strictEqual(formatCopilotModelDisplayName("gpt-5.3-codex"), "GPT-5.3 Codex");
      assert.strictEqual(
        formatCopilotModelDisplayName("claude-opus-4.6-fast"),
        "Claude Opus 4.6 (fast mode) (Preview)",
      );
    });
  });
});
