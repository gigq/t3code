import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { layer as NodePtyLayer } from "../../terminal/Layers/NodePTY.ts";
import { ClaudePtyAdapter } from "../Services/ClaudePtyAdapter.ts";
import { makeClaudePtyAdapterLive } from "./ClaudePtyAdapter.ts";

const ENABLED = process.env.CLAUDE_PTY_ADAPTER_SMOKE === "1";
const CWD = process.env.CLAUDE_PTY_SMOKE_CWD ?? process.cwd();
const BINARY = process.env.CLAUDE_PTY_SMOKE_BINARY ?? "claude";
const MODEL = process.env.CLAUDE_PTY_SMOKE_MODEL ?? "claude-opus-4-7";
const EFFORT = readEffort(process.env.CLAUDE_PTY_SMOKE_EFFORT);
const TIMEOUT_MS = Number(process.env.CLAUDE_PTY_SMOKE_TIMEOUT_MS ?? "120000");
const POLL_MS = 500;

function readEffort(
  value: string | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | "ultrathink" {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultrathink":
      return value;
    default:
      return "high";
  }
}

function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

async function findClaudeTranscript(sessionId: string): Promise<string | undefined> {
  const exact = join(
    homedir(),
    ".claude",
    "projects",
    claudeProjectDirectoryName(CWD),
    `${sessionId}.jsonl`,
  );
  try {
    await readFile(exact, "utf8");
    return exact;
  } catch {
    // Keep scanning; Claude can store transcripts by its resolved cwd.
  }

  const projectsDir = join(homedir(), ".claude", "projects");
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Keep scanning.
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordText(record: unknown): string {
  const entry = asRecord(record);
  const message = asRecord(entry?.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      const typed = asRecord(block);
      return typed?.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
    })
    .join("");
}

function jsonlRecords(jsonl: string): unknown[] {
  const records: unknown[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Claude can append while we read; ignore partial trailing JSON.
    }
  }
  return records;
}

async function readTranscriptForSession(sessionId: string): Promise<string> {
  const path = await findClaudeTranscript(sessionId);
  return path ? await readFile(path, "utf8") : "";
}

async function waitForTranscript(
  sessionId: string,
  predicate: (jsonl: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    last = await readTranscriptForSession(sessionId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return last;
}

function transcriptHasUserPrompt(jsonl: string, prompt: string): boolean {
  return jsonlRecords(jsonl).some((record) => {
    const entry = asRecord(record);
    if (entry?.type === "last-prompt" && entry.lastPrompt === prompt) return true;
    return entry?.type === "user" && recordText(record) === prompt;
  });
}

function transcriptHasAssistantText(jsonl: string, text: string): boolean {
  return jsonlRecords(jsonl).some((record) => {
    const entry = asRecord(record);
    return entry?.type === "assistant" && recordText(record).includes(text);
  });
}

function makeLayer() {
  return makeClaudePtyAdapterLive().pipe(
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          claudePty: {
            enabled: true,
            binaryPath: BINARY,
            customModels: [],
          },
        },
      }),
    ),
    Layer.provideMerge(NodePtyLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function runPhase(input: {
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly expectedText: string;
  readonly resumeCursor?: unknown;
}): Promise<unknown> {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* ClaudePtyAdapter;
      const session = yield* adapter.startSession({
        provider: "claudePty",
        threadId: input.threadId,
        runtimeMode: "full-access",
        cwd: CWD,
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        modelSelection: {
          provider: "claudePty",
          model: MODEL,
          options: { effort: EFFORT },
        },
      });
      const resumeCursor = session.resumeCursor;
      const sessionId = asRecord(resumeCursor)?.sessionId;
      assert.equal(typeof sessionId, "string");

      yield* adapter.sendTurn({
        threadId: input.threadId,
        input: input.prompt,
        attachments: [],
        interactionMode: "default",
        modelSelection: {
          provider: "claudePty",
          model: MODEL,
          options: { effort: EFFORT },
        },
      });

      const acknowledged = yield* Effect.promise(() =>
        waitForTranscript(String(sessionId), (jsonl) =>
          transcriptHasUserPrompt(jsonl, input.prompt),
        ),
      );
      assert.equal(
        transcriptHasUserPrompt(acknowledged, input.prompt),
        true,
        `Claude transcript never recorded prompt: ${input.prompt}`,
      );

      const answered = yield* Effect.promise(() =>
        waitForTranscript(String(sessionId), (jsonl) =>
          transcriptHasAssistantText(jsonl, input.expectedText),
        ),
      );
      assert.equal(
        transcriptHasAssistantText(answered, input.expectedText),
        true,
        `Claude transcript never recorded assistant text: ${input.expectedText}`,
      );

      yield* adapter.stopAll();
      return resumeCursor;
    }).pipe(Effect.provide(makeLayer())),
  );
}

it.skipIf(!ENABLED)(
  "drives a real local Claude PTY turn, recreates the adapter, then resumes the session",
  async () => {
    const threadId = ThreadId.makeUnsafe(`claude-pty-live-${crypto.randomUUID()}`);
    const firstCursor = await runPhase({
      threadId,
      prompt: "T3 Claude PTY adapter live smoke first prompt. Reply with exactly LIVE_ONE.",
      expectedText: "LIVE_ONE",
    });
    await runPhase({
      threadId,
      prompt:
        "T3 Claude PTY adapter live smoke second prompt after adapter restart. Reply with exactly LIVE_TWO.",
      expectedText: "LIVE_TWO",
      resumeCursor: firstCursor,
    });
  },
  TIMEOUT_MS * 2 + 30_000,
);
