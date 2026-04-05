export const AUTO_MODE_NOOP_SENTINEL = "<t3code:auto-noop />";

export const AUTO_MODE_POLL_INTERVAL_MS = 5_000;
export const AUTO_MODE_WAKE_DELAY_MS = 45_000;
export const AUTO_MODE_RETRY_DELAY_MS = 120_000;
export const AUTO_MODE_DEFER_PRESETS = ["15m", "1h", "tomorrow-8am"] as const;
export type AutoModeDeferPreset = (typeof AUTO_MODE_DEFER_PRESETS)[number];

export function isAutoModeNoopMessage(text: string): boolean {
  return text.trim() === AUTO_MODE_NOOP_SENTINEL;
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
    `If there is nothing worth doing right now, respond with exactly ${AUTO_MODE_NOOP_SENTINEL} and nothing else.`,
    "</auto_tick>",
  ].join("\n");
}
