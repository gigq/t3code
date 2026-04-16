import { describe, expect, it } from "vitest";

import { flattenOpenCodeModels, type OpenCodeInventory } from "./opencodeRuntime.ts";

describe("flattenOpenCodeModels", () => {
  it("infers Claude high/max variants for anthropic models exposed through Copilot", () => {
    const inventory: OpenCodeInventory = {
      providerList: {
        connected: ["copilot"],
        default: {},
        all: [
          {
            id: "copilot",
            name: "GitHub Copilot",
            models: {
              "claude-sonnet-4.5": {
                id: "claude-sonnet-4.5",
                name: "Claude Sonnet 4.5",
                release_date: "",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                cache_control: false,
              } as any,
            },
          } as any,
        ],
      },
      agents: [],
    };

    expect(flattenOpenCodeModels(inventory)).toEqual([
      {
        slug: "copilot/claude-sonnet-4.5",
        name: "GitHub Copilot · Claude Sonnet 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          variantOptions: [
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        },
      },
    ]);
  });

  it("preserves explicit model variants when OpenCode provides them", () => {
    const inventory: OpenCodeInventory = {
      providerList: {
        connected: ["copilot"],
        default: {},
        all: [
          {
            id: "copilot",
            name: "GitHub Copilot",
            models: {
              "claude-opus-4.1": {
                id: "claude-opus-4.1",
                name: "Claude Opus 4.1",
                release_date: "",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                cache_control: false,
                variants: {
                  high: {},
                },
              } as any,
            },
          } as any,
        ],
      },
      agents: [],
    };

    const models = flattenOpenCodeModels(inventory);

    expect(models).toHaveLength(1);
    const firstModel = models[0];
    expect(firstModel).toBeDefined();
    if (!firstModel) {
      throw new Error("Expected a flattened OpenCode model.");
    }
    const capabilities = firstModel.capabilities;
    if (!capabilities) {
      throw new Error("Expected flattened model capabilities.");
    }
    expect(capabilities.variantOptions ?? null).toEqual([
      { value: "high", label: "High", isDefault: true },
    ]);
  });
});
