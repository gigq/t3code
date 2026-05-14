#!/usr/bin/env node
/* oxlint-disable no-control-regex */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const cwd = resolve(process.env.CLAUDE_PTY_SMOKE_CWD ?? process.cwd());
const binary = process.env.CLAUDE_PTY_SMOKE_BINARY ?? "claude";
const model = process.env.CLAUDE_PTY_SMOKE_MODEL ?? "claude-opus-4-7";
const effort = process.env.CLAUDE_PTY_SMOKE_EFFORT ?? "high";
const sessionId = process.env.CLAUDE_PTY_SMOKE_SESSION_ID ?? randomUUID();
const timeoutMs = Number(process.env.CLAUDE_PTY_SMOKE_TIMEOUT_MS ?? "90000");
const ackTimeoutMs = Number(process.env.CLAUDE_PTY_SMOKE_ACK_TIMEOUT_MS ?? "5000");
const retryLimit = Number(process.env.CLAUDE_PTY_SMOKE_RETRY_LIMIT ?? "12");
const OSC_SEQUENCE_RE = new RegExp("\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)", "g");
const CSI_SEQUENCE_RE = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g");
const STRING_SEQUENCE_RE = new RegExp("\\u001b[PX^_].*?\\u001b\\\\", "gs");
const SINGLE_ESCAPE_RE = new RegExp("\\u001b[@-Z\\\\-_]", "g");

function log(message, detail) {
  const suffix =
    detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value) {
  return value
    .replace(OSC_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(STRING_SEQUENCE_RE, "")
    .replace(SINGLE_ESCAPE_RE, "");
}

function outputLooksReady(value) {
  const compact = stripAnsi(value)
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s+/g, "")
    .toLowerCase();
  return (
    compact.includes("❯") &&
    (compact.includes("shift+tabtocycle") ||
      compact.includes("/effort") ||
      compact.includes("bypasspermissions"))
  );
}

function projectDirectoryName(path) {
  return path.replaceAll("/", "-");
}

function transcriptPath() {
  return join(homedir(), ".claude", "projects", projectDirectoryName(cwd), `${sessionId}.jsonl`);
}

function readTranscript() {
  const path = transcriptPath();
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function parseJsonl(jsonl) {
  const records = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Claude can append while we read. Ignore partial trailing records.
    }
  }
  return records;
}

function recordText(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      if (block?.type === "text" && typeof block.text === "string") return [block.text];
      return [];
    })
    .join("");
}

function transcriptHasUserPrompt(prompt) {
  return parseJsonl(readTranscript()).some((record) => {
    if (record?.type === "last-prompt" && record.lastPrompt === prompt) return true;
    return record?.type === "user" && recordText(record) === prompt;
  });
}

function transcriptHasAssistantText(marker) {
  return parseJsonl(readTranscript()).some(
    (record) => record?.type === "assistant" && recordText(record).includes(marker),
  );
}

function lineCount() {
  const text = readTranscript();
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function buildArgs(mode) {
  return [
    mode === "resume" ? "--resume" : "--session-id",
    sessionId,
    "--name",
    "T3 PTY resume smoke",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ];
}

function spawnClaude(mode) {
  const args = buildArgs(mode);
  log(`spawn ${binary}`, args);
  const proc = pty.spawn(binary, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  let output = "";
  let ready = false;
  proc.onData((data) => {
    output = `${output}${data}`.slice(-20000);
    if (!ready && outputLooksReady(output)) {
      ready = true;
      log(`${mode} tui ready`);
    }
  });
  proc.onExit((event) => {
    log(`${mode} process exit`, event);
  });
  return {
    proc,
    getOutput: () => output,
    isReady: () => ready,
  };
}

async function waitUntil(label, predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  log(`${label} timed out`);
  return false;
}

function bracketedPaste(prompt) {
  return `\x1b[200~${prompt}\x1b[201~\r`;
}

function clearedPlainInput(prompt) {
  return `\x15${prompt}\r`;
}

async function sendAndWaitForAck(handle, prompt, { resume }) {
  const before = lineCount();
  log("send prompt", { resume, before, prompt });
  handle.proc.write(bracketedPaste(prompt));
  if (
    await waitUntil(
      "prompt ack after bracketed paste",
      () => transcriptHasUserPrompt(prompt),
      ackTimeoutMs,
    )
  ) {
    log("prompt acknowledged after bracketed paste", { after: lineCount() });
    return true;
  }
  const maxRetries = resume ? retryLimit : 1;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    log("retry prompt", { attempt, mode: resume ? "ctrl-u plain" : "plain" });
    handle.proc.write(resume ? clearedPlainInput(prompt) : `${prompt}\r`);
    if (
      await waitUntil(
        `prompt ack after retry ${attempt}`,
        () => transcriptHasUserPrompt(prompt),
        ackTimeoutMs,
      )
    ) {
      log("prompt acknowledged after retry", { attempt, after: lineCount() });
      return true;
    }
  }
  return false;
}

async function runPhase(mode, prompt, marker) {
  const handle = spawnClaude(mode);
  await waitUntil(`${mode} tui ready`, () => handle.isReady(), mode === "resume" ? 20000 : 10000);
  const acked = await sendAndWaitForAck(handle, prompt, { resume: mode === "resume" });
  if (!acked) {
    log("prompt was not acknowledged", {
      transcriptPath: transcriptPath(),
      lines: lineCount(),
      outputTail: stripAnsi(handle.getOutput()).slice(-2000),
    });
    handle.proc.kill();
    return false;
  }
  const answered = await waitUntil(
    `assistant marker ${marker}`,
    () => transcriptHasAssistantText(marker),
    timeoutMs,
  );
  log("assistant result", { marker, answered, lines: lineCount() });
  handle.proc.kill();
  await sleep(1000);
  return answered;
}

log("starting Claude PTY resume smoke", {
  cwd,
  binary,
  model,
  effort,
  sessionId,
  transcriptPath: transcriptPath(),
});

const firstPrompt = "T3 PTY resume smoke first prompt. Reply with exactly SMOKE_ONE.";
const secondPrompt =
  "T3 PTY resume smoke second prompt after restart. Reply with exactly SMOKE_TWO.";

const firstOk = await runPhase("fresh", firstPrompt, "SMOKE_ONE");
if (!firstOk) {
  log("fresh phase failed");
  process.exit(1);
}

const secondOk = await runPhase("resume", secondPrompt, "SMOKE_TWO");
if (!secondOk) {
  log("resume phase failed");
  process.exit(1);
}

log("Claude PTY resume smoke passed", {
  sessionId,
  transcriptPath: transcriptPath(),
  lines: lineCount(),
});
