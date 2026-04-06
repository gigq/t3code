export const AUTO_MODE_NOOP_SENTINEL = "<t3code:auto-noop />";
export const AUTO_MODE_DEFER_CONTROL_PREFIX = "<t3code:auto-defer";
export const AUTO_MODE_STOP_SENTINEL = "<t3code:auto-stop />";

export const AUTO_MODE_POLL_INTERVAL_MS = 5_000;
export const AUTO_MODE_WAKE_DELAY_MS = 45_000;
export const AUTO_MODE_RETRY_DELAY_MS = 120_000;
export const AUTO_MODE_DEFER_PRESETS = ["15m", "1h", "tomorrow-8am"] as const;
export type AutoModeDeferPreset = (typeof AUTO_MODE_DEFER_PRESETS)[number];

export type AutoModeControlMessage =
  | { kind: "noop" }
  | { kind: "defer"; deferUntil: string }
  | { kind: "stop" };

export function isAutoModeNoopMessage(text: string): boolean {
  return text.trim() === AUTO_MODE_NOOP_SENTINEL;
}

export function parseAutoModeControlMessage(
  text: string,
  now: Date = new Date(),
): AutoModeControlMessage | null {
  const trimmed = text.trim();
  if (trimmed === AUTO_MODE_NOOP_SENTINEL) {
    return { kind: "noop" };
  }

  if (trimmed === AUTO_MODE_STOP_SENTINEL) {
    return { kind: "stop" };
  }

  const presetMatch = /^<t3code:auto-defer\s+preset="(15m|1h|tomorrow-8am)"\s*\/>$/.exec(trimmed);
  if (presetMatch?.[1]) {
    return {
      kind: "defer",
      deferUntil: resolveAutoModeDeferUntil(presetMatch[1] as AutoModeDeferPreset, now),
    };
  }

  const untilMatch = /^<t3code:auto-defer\s+until="([^"]+)"\s*\/>$/.exec(trimmed);
  if (untilMatch?.[1]) {
    const parsedMs = parseAutoModeDeferUntilMs(untilMatch[1]);
    if (parsedMs !== null) {
      return {
        kind: "defer",
        deferUntil: new Date(parsedMs).toISOString(),
      };
    }
  }

  return null;
}

export function isAutoModeHiddenControlMessage(text: string): boolean {
  return parseAutoModeControlMessage(text) !== null;
}

export function isAutoModeTickPromptMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<auto_tick>") && trimmed.endsWith("</auto_tick>");
}

export function isAutoModeHiddenMessage(text: string): boolean {
  return isAutoModeHiddenControlMessage(text) || isAutoModeTickPromptMessage(text);
}

export function parseAutoModeDeferUntilMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

export function isAutoModeDeferred(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const deferredUntilMs = parseAutoModeDeferUntilMs(value);
  return deferredUntilMs !== null && deferredUntilMs > nowMs;
}

export function resolveAutoModeDeferUntil(
  preset: AutoModeDeferPreset,
  now: Date = new Date(),
): string {
  const deferredAt = new Date(now);
  switch (preset) {
    case "15m":
      deferredAt.setMinutes(deferredAt.getMinutes() + 15);
      break;
    case "1h":
      deferredAt.setHours(deferredAt.getHours() + 1);
      break;
    case "tomorrow-8am":
      deferredAt.setDate(deferredAt.getDate() + 1);
      deferredAt.setHours(8, 0, 0, 0);
      break;
  }
  return deferredAt.toISOString();
}

export function buildAutoModeTickPrompt(nowIso: string): string {
  return [
    "<auto_tick>",
    `Current time: ${nowIso}`,
    "You are in background auto mode for an active coding thread.",
    "Review the latest repository state, recent errors, pending follow-ups, and unfinished work.",
    "If there is a concrete useful action you can safely take right now, take it and keep any user-facing update concise.",
    "If the thread already has an accepted plan or an obvious in-progress checklist, keep executing it until the plan is complete or you are truly blocked.",
    "Do not stop merely because you finished one step if the remaining planned work is still actionable.",
    'If you want to sleep until later, respond with exactly one control tag like <t3code:auto-defer preset="15m" />, <t3code:auto-defer preset="1h" />, <t3code:auto-defer preset="tomorrow-8am" />, or <t3code:auto-defer until="2026-04-06T13:00:00.000Z" />.',
    `If you have reached a clean stopping point and do not expect a useful next step until the user changes something, respond with exactly ${AUTO_MODE_STOP_SENTINEL}.`,
    `If there is nothing worth doing right now, respond with exactly ${AUTO_MODE_NOOP_SENTINEL} and nothing else.`,
    "</auto_tick>",
  ].join("\n");
}
