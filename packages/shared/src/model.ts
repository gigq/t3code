import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  type CopilotModelOptions,
  type CodexModelOptions,
  type ModelCapabilities,
  type ModelSelection,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
} from "@t3tools/contracts";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  return defaultValue ?? undefined;
}

export function hasContextWindowOption(caps: ModelCapabilities, value: string): boolean {
  return caps.contextWindowOptions.some((o) => o.value === value);
}

export function getDefaultContextWindow(caps: ModelCapabilities): string | null {
  return caps.contextWindowOptions.find((o) => o.isDefault)?.value ?? null;
}

export function resolveContextWindow(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultContextWindow(caps);
  if (!raw) return defaultValue ?? undefined;
  return hasContextWindowOption(caps, raw) ? raw : (defaultValue ?? undefined);
}

export function normalizeCodexModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort
      ? { reasoningEffort: reasoningEffort as CodexModelOptions["reasoningEffort"] }
      : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const effort = resolveEffort(caps, modelOptions?.effort);
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: ClaudeModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort: effort as ClaudeModelOptions["effort"] } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeCopilotModelOptionsWithCapabilities(
  _caps: ModelCapabilities,
  _modelOptions: CopilotModelOptions | null | undefined,
): CopilotModelOptions | undefined {
  return undefined;
}

function resolveLabeledOption(
  options: ReadonlyArray<{ value: string; isDefault?: boolean | undefined }> | undefined,
  raw: string | null | undefined,
): string | undefined {
  if (!options || options.length === 0) {
    return raw ?? undefined;
  }
  if (raw && options.some((option) => option.value === raw)) {
    return raw;
  }
  return options.find((option) => option.isDefault)?.value;
}

export function normalizeOpenCodeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: OpenCodeModelOptions | null | undefined,
): OpenCodeModelOptions | undefined {
  const variant = resolveLabeledOption(caps.variantOptions, trimOrNull(modelOptions?.variant));
  const agent = resolveLabeledOption(caps.agentOptions, trimOrNull(modelOptions?.agent));
  const nextOptions: OpenCodeModelOptions = {
    ...(variant ? { variant } : {}),
    ...(agent ? { agent } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeProviderModelOptionsWithCapabilities(
  provider: ProviderKind,
  caps: ModelCapabilities,
  modelOptions: ProviderModelOptions[ProviderKind] | null | undefined,
): ProviderModelOptions[ProviderKind] | undefined {
  switch (provider) {
    case "codex":
      return normalizeCodexModelOptionsWithCapabilities(caps, modelOptions as CodexModelOptions);
    case "claudeAgent":
      return normalizeClaudeModelOptionsWithCapabilities(caps, modelOptions as ClaudeModelOptions);
    case "copilot":
      return normalizeCopilotModelOptionsWithCapabilities(
        caps,
        modelOptions as CopilotModelOptions,
      );
    case "opencode":
      return normalizeOpenCodeModelOptionsWithCapabilities(
        caps,
        modelOptions as OpenCodeModelOptions,
      );
  }
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }
  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }
  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }
  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }
  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

export function createModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind] | undefined,
): ModelSelection {
  switch (provider) {
    case "codex":
      return {
        provider,
        model,
        ...(options ? { options: options as CodexModelOptions } : {}),
      };
    case "claudeAgent":
      return {
        provider,
        model,
        ...(options ? { options: options as ClaudeModelOptions } : {}),
      };
    case "copilot":
      return {
        provider,
        model,
        ...(options ? { options: options as CopilotModelOptions } : {}),
      };
    case "opencode":
      return {
        provider,
        model,
        ...(options ? { options: options as OpenCodeModelOptions } : {}),
      };
  }
}

export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      switch (modelSelection.options?.contextWindow) {
        case "1m":
          return `${modelSelection.model}[1m]`;
        default:
          return modelSelection.model;
      }
    }
    case "copilot": {
      return modelSelection.model === "default"
        ? DEFAULT_MODEL_BY_PROVIDER.copilot
        : modelSelection.model;
    }
    case "opencode": {
      return modelSelection.model;
    }
    default: {
      return modelSelection.model;
    }
  }
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
