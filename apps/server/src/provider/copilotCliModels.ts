import fs from "node:fs";
import path from "node:path";

import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";

const FALLBACK_COPILOT_MODEL_SLUGS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
  "claude-opus-4.5",
  "claude-sonnet-4",
  "gemini-3-pro-preview",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5.1-codex-mini",
  "gpt-5-mini",
  "gpt-4.1",
] as const;

const COPILOT_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-opus-4.6-fast": "Claude Opus 4.6 (fast mode) (Preview)",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-sonnet-4": "Claude Sonnet 4",
  "gemini-3-pro-preview": "Gemini 3 Pro Preview",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5-mini": "GPT-5 mini",
  "gpt-4.1": "GPT-4.1",
};

function resolveExecutablePath(binaryPath: string): string | null {
  const trimmed = binaryPath.trim();
  if (!trimmed) {
    return null;
  }

  const candidates: string[] = [];
  if (path.isAbsolute(trimmed)) {
    candidates.push(trimmed);
  } else {
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const windowsExtensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .map((entry) => entry.toLowerCase())
            .filter(Boolean)
        : [""];
    for (const entry of pathEntries) {
      const baseCandidate = path.join(entry, trimmed);
      if (process.platform === "win32") {
        candidates.push(baseCandidate);
        for (const extension of windowsExtensions) {
          candidates.push(
            baseCandidate.endsWith(extension) ? baseCandidate : `${baseCandidate}${extension}`,
          );
        }
      } else {
        candidates.push(baseCandidate);
      }
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.realpathSync(candidate);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function getCopilotBundleCandidates(binaryPath: string): string[] {
  const executablePath = resolveExecutablePath(binaryPath);
  if (!executablePath) {
    return [];
  }

  const packageRoot = path.dirname(executablePath);
  const parent = path.resolve(packageRoot, "..");
  const candidates = [
    path.join(packageRoot, "app.js"),
    path.join(packageRoot, "sdk", "index.js"),
    path.join(packageRoot, "copilot-sdk", "index.js"),
    path.join(parent, "app.js"),
    path.join(parent, "sdk", "index.js"),
    path.join(parent, "copilot-sdk", "index.js"),
  ];
  return [...new Set(candidates)];
}

export function formatCopilotModelDisplayName(slug: string): string {
  return COPILOT_MODEL_DISPLAY_NAMES[slug] ?? slug;
}

export function parseCopilotBundledModelSlugsFromSource(source: string): string[] {
  const match = source.match(
    /\b([A-Za-z_$][\w$]*)=(\[(?:"[^"]+"(?:,\s*"[^"]+")*)?\]),([A-Za-z_$][\w$]*)=new Set\((\[(?:"[^"]+"(?:,\s*"[^"]+")*)?\])\),([A-Za-z_$][\w$]*)=\1\.filter\(/s,
  );
  const allModelsJson = match?.[2];
  const hiddenModelsJson = match?.[4];
  if (!allModelsJson || !hiddenModelsJson) {
    return [];
  }

  try {
    const allModels = JSON.parse(allModelsJson) as unknown;
    const hiddenModels = JSON.parse(hiddenModelsJson) as unknown;
    if (!Array.isArray(allModels) || !Array.isArray(hiddenModels)) {
      return [];
    }

    const hidden = new Set(
      hiddenModels.filter((entry): entry is string => typeof entry === "string"),
    );
    return allModels.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0 && !hidden.has(entry),
    );
  } catch {
    return [];
  }
}

export function loadCopilotBundledModelSlugs(binaryPath: string): string[] {
  for (const candidate of getCopilotBundleCandidates(binaryPath)) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const source = fs.readFileSync(candidate, "utf8");
      const parsed = parseCopilotBundledModelSlugsFromSource(source);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return [...FALLBACK_COPILOT_MODEL_SLUGS];
}

export function buildCopilotBuiltInModels(
  binaryPath: string,
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  return [
    {
      slug: "default",
      name: "Default",
      isCustom: false,
      capabilities,
    },
    ...loadCopilotBundledModelSlugs(binaryPath).map((slug) => ({
      slug,
      name: formatCopilotModelDisplayName(slug),
      isCustom: false,
      capabilities,
    })),
  ];
}
