import path from "node:path";
import { access } from "node:fs/promises";

import type {
  ServerCodexUsage,
  ServerCodexUsageWindow,
  ServerProviderUsage,
} from "@t3tools/contracts";
import { runProcess } from "./processRunner";

const CODEXBAR_TIMEOUT_MS = 20_000;
const CODEXBAR_MAX_BUFFER_BYTES = 256 * 1024;
const CODEX_STATUS_TIMEOUT_MS = 15_000;
const CODEX_STATUS_MAX_BUFFER_BYTES = 512 * 1024;

const ANSI_RE = new RegExp(
  String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])`,
  "g",
);
const STATUS_LIMIT_RE =
  /^(5h|Weekly) limit:\s*(?:\[[^\]]*\]\s*)?(\d+)% left(?:\s*\(resets (.+)\))?$/i;
const STATUS_SPARK_SECTION_RE = /Codex-Spark limit:/i;

type JsonRecord = Record<string, unknown>;

type ParsedCodexStatusUsage = {
  primary: ServerCodexUsageWindow | null;
  secondary: ServerCodexUsageWindow | null;
  sparkPrimary: ServerCodexUsageWindow | null;
  sparkSecondary: ServerCodexUsageWindow | null;
};

function providerDisplayName(provider: string): string {
  return provider === "codex" ? "Codex" : provider;
}

function emptyProviderUsage(provider: string, error: string): ServerProviderUsage {
  return {
    available: false,
    provider,
    accountEmail: null,
    loginMethod: null,
    source: null,
    version: null,
    primary: null,
    secondary: null,
    sparkPrimary: null,
    sparkSecondary: null,
    creditsRemaining: null,
    updatedAt: null,
    error,
  };
}

function emptyCodexUsage(error: string): ServerCodexUsage {
  return emptyProviderUsage("codex", error);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asIsoDateTime(value: unknown): string | null {
  return asNonEmptyString(value);
}

function normalizeUsageWindow(value: unknown): ServerCodexUsageWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = asNumber(record.usedPercent);
  const leftPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);

  return {
    windowMinutes: asNumber(record.windowMinutes),
    usedPercent,
    leftPercent,
    resetsAt: asIsoDateTime(record.resetsAt),
    resetDescription: asNonEmptyString(record.resetDescription),
  };
}

function usageWindowFromLeftPercent(
  windowMinutes: number,
  leftPercent: number,
  resetDescription: string | null,
): ServerCodexUsageWindow {
  return {
    windowMinutes,
    usedPercent: Math.max(0, 100 - leftPercent),
    leftPercent,
    resetsAt: null,
    resetDescription,
  };
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\r/g, "\n");
}

function normalizeStatusLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^│\s?/, "")
    .replace(/\s*│$/, "")
    .trim();
  if (!normalized) {
    return null;
  }

  if (/^[╭╮╰╯─]+$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeStatusLines(text: string): string[] {
  const merged: string[] = [];

  for (const rawLine of stripAnsi(text).split("\n")) {
    const line = normalizeStatusLine(rawLine);
    if (!line) {
      continue;
    }
    if (line.startsWith("(resets ") && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${line}`;
      continue;
    }
    merged.push(line);
  }

  return merged;
}

export function parseCodexStatusText(text: string): ParsedCodexStatusUsage | null {
  const result: ParsedCodexStatusUsage = {
    primary: null,
    secondary: null,
    sparkPrimary: null,
    sparkSecondary: null,
  };

  let section: "primary" | "spark" = "primary";

  for (const line of normalizeStatusLines(text)) {
    if (STATUS_SPARK_SECTION_RE.test(line)) {
      section = "spark";
      continue;
    }

    const match = STATUS_LIMIT_RE.exec(line);
    if (!match) {
      continue;
    }

    const [, rawWindowLabel = "", rawLeftPercent = "", rawResetDescription] = match;
    const slot = rawWindowLabel.toLowerCase() === "5h" ? "primary" : "secondary";
    const leftPercent = Number.parseInt(rawLeftPercent, 10);
    const resetDescription = asNonEmptyString(rawResetDescription);
    const window = usageWindowFromLeftPercent(
      slot === "primary" ? 300 : 10_080,
      leftPercent,
      resetDescription,
    );

    if (section === "spark") {
      if (slot === "primary") {
        result.sparkPrimary = window;
      } else {
        result.sparkSecondary = window;
      }
      continue;
    }

    if (slot === "primary") {
      result.primary = window;
    } else {
      result.secondary = window;
    }
  }

  return result.primary || result.secondary || result.sparkPrimary || result.sparkSecondary
    ? result
    : null;
}

function normalizeCodexbarUsagePayloadInternal(
  payload: unknown,
  fallbackProvider = "codex",
): ServerProviderUsage {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const record = asRecord(root);
  if (!record) {
    return emptyProviderUsage(
      fallbackProvider,
      `${providerDisplayName(fallbackProvider)} usage returned invalid JSON.`,
    );
  }

  const provider = asNonEmptyString(record.provider) ?? fallbackProvider;
  const usage = asRecord(record.usage);
  const identity = asRecord(usage?.identity);
  const primary = normalizeUsageWindow(usage?.primary);
  const secondary = normalizeUsageWindow(usage?.secondary);
  const credits = asRecord(record.credits);
  const accountEmail =
    asNonEmptyString(usage?.accountEmail) ?? asNonEmptyString(identity?.accountEmail);
  const loginMethod =
    asNonEmptyString(usage?.loginMethod) ?? asNonEmptyString(identity?.loginMethod);
  const source = asNonEmptyString(record.source);
  const version = asNonEmptyString(record.version);
  const updatedAt =
    asIsoDateTime(usage?.updatedAt) ??
    asIsoDateTime(credits?.updatedAt) ??
    asIsoDateTime(record.updatedAt);

  if (!primary) {
    return {
      ...emptyProviderUsage(
        provider,
        `Primary ${providerDisplayName(provider)} usage window is missing.`,
      ),
      provider,
      accountEmail,
      loginMethod,
      source,
      version,
      secondary,
      creditsRemaining: asNumber(credits?.remaining),
      updatedAt,
    };
  }

  return {
    available: true,
    provider,
    accountEmail,
    loginMethod,
    source,
    version,
    primary,
    secondary,
    sparkPrimary: null,
    sparkSecondary: null,
    creditsRemaining: asNumber(credits?.remaining),
    updatedAt,
    error: null,
  };
}

async function resolveCodexStatusScriptPath(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "scripts/capture-codex-status.py"),
    path.resolve(process.cwd(), "apps/server/scripts/capture-codex-status.py"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Codex status capture helper is missing.");
}

async function getCodexStatusUsage(): Promise<ParsedCodexStatusUsage | null> {
  try {
    const scriptPath = await resolveCodexStatusScriptPath();
    const result = await runProcess("python3", [scriptPath], {
      timeoutMs: CODEX_STATUS_TIMEOUT_MS,
      maxBufferBytes: CODEX_STATUS_MAX_BUFFER_BYTES,
      outputMode: "truncate",
    });
    return parseCodexStatusText(result.stdout);
  } catch {
    return null;
  }
}

function mergeCodexUsage(
  codexbarUsage: ServerCodexUsage,
  statusUsage: ParsedCodexStatusUsage | null,
): ServerCodexUsage {
  const primary = codexbarUsage.primary ?? statusUsage?.primary ?? null;
  const secondary = codexbarUsage.secondary ?? statusUsage?.secondary ?? null;
  const available = codexbarUsage.available || primary !== null;

  return {
    ...codexbarUsage,
    available,
    primary,
    secondary,
    sparkPrimary: statusUsage?.sparkPrimary ?? null,
    sparkSecondary: statusUsage?.sparkSecondary ?? null,
    error: available ? null : codexbarUsage.error,
  };
}

export function normalizeCodexbarUsagePayload(payload: unknown): ServerCodexUsage {
  return normalizeCodexbarUsagePayloadInternal(payload, "codex");
}

async function getCodexbarProviderUsage(provider: string): Promise<ServerProviderUsage> {
  try {
    const result = await runProcess(
      "codexbar",
      ["--provider", provider, "--source", "auto", "--format", "json"],
      {
        timeoutMs: CODEXBAR_TIMEOUT_MS,
        maxBufferBytes: CODEXBAR_MAX_BUFFER_BYTES,
        outputMode: "truncate",
      },
    );
    return normalizeCodexbarUsagePayloadInternal(JSON.parse(result.stdout), provider);
  } catch (error) {
    return emptyProviderUsage(
      provider,
      error instanceof Error ? error.message : `Failed to load ${provider} usage.`,
    );
  }
}

export async function getCodexUsage(): Promise<ServerCodexUsage> {
  const [codexbarResult, statusResult, claudeResult] = await Promise.allSettled([
    getCodexbarProviderUsage("codex"),
    getCodexStatusUsage(),
    getCodexbarProviderUsage("claude"),
  ]);

  const codexbarUsage =
    codexbarResult.status === "fulfilled"
      ? codexbarResult.value
      : emptyCodexUsage(
          codexbarResult.reason instanceof Error
            ? codexbarResult.reason.message
            : "Failed to load Codex usage.",
        );

  const statusUsage = statusResult.status === "fulfilled" ? statusResult.value : null;
  const claudeUsage = claudeResult.status === "fulfilled" ? claudeResult.value : null;
  return {
    ...mergeCodexUsage(codexbarUsage, statusUsage),
    ...(claudeUsage ? { additionalProviders: [claudeUsage] } : {}),
  };
}
