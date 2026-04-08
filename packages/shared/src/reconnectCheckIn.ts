export function buildReconnectCheckInPrompt(nowIso: string): string {
  return [
    "<reconnect_checkin>",
    `Current time: ${nowIso}`,
    "The server connection restarted while this thread was mid-turn.",
    "Review the latest repository state, recent tool output, and unfinished work in this thread.",
    "If there is still clear unfinished work from the interrupted turn, continue it now and finish your thought.",
    "If the task is already complete, reply with a concise normal user-facing update summarizing the result.",
    "Do not mention this hidden reconnect check-in or ask the user to resend the same request unless you are truly blocked.",
    "</reconnect_checkin>",
  ].join("\n");
}
