import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ThreadId } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PtyAdapter, type PtyProcess, type PtySpawnInput } from "../../terminal/Services/PTY.ts";
import { ClaudePtyAdapter } from "../Services/ClaudePtyAdapter.ts";
import {
  buildClaudeArgs,
  buildClaudePtyLaunch,
  claudePtyOutputLooksInputReady,
  makeClaudePtyAdapterLive,
  parseClaudeTranscriptAssistantMessages,
  parseClaudeTranscriptEvents,
} from "./ClaudePtyAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

class FakePtyProcess implements PtyProcess {
  readonly pid = 1234;
  readonly writes: string[] = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {
    // The provider does not resize PTYs in v1.
  }

  kill(signal?: string): void {
    this.kills.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: { exitCode: number; signal: number | null }) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: { exitCode: number; signal: number | null }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

function makeHarness() {
  const spawned: PtySpawnInput[] = [];
  const processes: FakePtyProcess[] = [];
  const ptyLayer = Layer.succeed(PtyAdapter, {
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push(input);
        const process = new FakePtyProcess();
        processes.push(process);
        return process;
      }),
  });

  const layer = makeClaudePtyAdapterLive().pipe(
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          claudePty: {
            enabled: true,
            binaryPath: "claude",
            customModels: [],
          },
        },
      }),
    ),
    Layer.provideMerge(ptyLayer),
  );

  return { layer, spawned, processes };
}

it("builds local launch args without print mode", () => {
  const args = buildClaudeArgs({
    model: "claude-sonnet-4-6",
    effort: "high",
    runtimeMode: "full-access",
    sessionId: "session-1",
    resume: false,
    threadId: asThreadId("thread-abcdef"),
  });

  assert.deepEqual(args, [
    "--session-id",
    "session-1",
    "--name",
    "T3 thread-a",
    "--model",
    "claude-sonnet-4-6",
    "--effort",
    "high",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("--print"), false);
  assert.equal(args.includes("--output-format"), false);
});

it("builds resume launch args for persisted PTY sessions", () => {
  const args = buildClaudeArgs({
    model: "claude-sonnet-4-6",
    effort: "high",
    runtimeMode: "full-access",
    sessionId: "session-1",
    resume: true,
    threadId: asThreadId("thread-abcdef"),
  });

  assert.equal(args[0], "--resume");
  assert.equal(args[1], "session-1");
  assert.equal(args.includes("--session-id"), false);
});

it("builds remote ssh launch with safe PATH prelude and no glob discovery", () => {
  const launch = buildClaudePtyLaunch({
    binaryPath: "claude",
    cwd: "/ignored/local",
    projectLocation: {
      kind: "ssh",
      host: "case",
      port: 22222,
      remotePath: "/Users/justin/git/gigq/reader",
    },
    args: ["--session-id", "session-1", "--model", "claude-sonnet-4-6"],
  });

  assert.equal(launch.shell, "ssh");
  assert.deepEqual(launch.args.slice(0, 4), ["-tt", "-p", "22222", "case"]);
  const remoteCommand = launch.args.at(-1) ?? "";
  assert.match(remoteCommand, /export PATH="\$HOME\/\.local\/bin:\$HOME\/\.bun\/bin:/);
  assert.match(remoteCommand, /Users\/justin\/git\/gigq\/reader/);
  assert.match(remoteCommand, /exec claude "\$@"/);
  assert.doesNotMatch(remoteCommand, /\*\/bin/);
});

it("detects Claude TUI input readiness from terminal output", () => {
  assert.equal(
    claudePtyOutputLooksInputReady(
      [
        "╭─── Claude Code v2.1.141 ───╮",
        "│ Welcome back Justin! │",
        "──────────────────── T3 debug ──",
        "❯ ",
        "⏵⏵ bypass permissions on (shift+tab to cycle) ● high · /effort",
      ].join("\n"),
    ),
    true,
  );
  assert.equal(
    claudePtyOutputLooksInputReady("Welcome back Justin! Conversation compacted"),
    false,
  );
});

it.effect("starts a PTY session and writes turns via bracketed paste", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudePtyAdapter;

    const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    const session = yield* adapter.startSession({
      provider: "claudePty",
      threadId: asThreadId("thread-pty-start"),
      runtimeMode: "full-access",
      cwd: "/repo",
      modelSelection: {
        provider: "claudePty",
        model: "claude-sonnet-4-6",
        options: { effort: "high" },
      },
    });
    const events = Array.from(yield* Fiber.join(eventsFiber));

    assert.equal(session.provider, "claudePty");
    const spawned = harness.spawned[0];
    assert.ok(spawned);
    assert.equal(spawned.shell, "claude");
    assert.deepEqual((spawned.args ?? []).includes("--print"), false);
    assert.deepEqual(
      events.map((event) => event.type),
      ["session.started", "session.configured", "session.state.changed"],
    );

    const pty = harness.processes[0];
    assert.ok(pty);
    const turnResult = yield* adapter.sendTurn({
      threadId: asThreadId("thread-pty-start"),
      input: "say hello",
      attachments: [],
      interactionMode: "default",
    });

    assert.equal(turnResult.threadId, "thread-pty-start");
    assert.equal(pty.writes.at(-1), "\x1b[200~say hello\x1b[201~\r");

    yield* adapter.interruptTurn(asThreadId("thread-pty-start"));
    yield* adapter.stopSession(asThreadId("thread-pty-start"));
  }).pipe(Effect.provide(harness.layer));
});

it("parses assistant text from Claude JSONL transcripts", () => {
  const messages = parseClaudeTranscriptAssistantMessages(
    [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "from disk" },
          ],
        },
      }),
      "{partial",
    ].join("\n"),
  );

  assert.deepEqual(messages, [{ uuid: "assistant-1", text: "hello from disk" }]);
});

it("parses Claude JSONL tool use and tool result events", () => {
  const events = parseClaudeTranscriptEvents(
    [
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-tool",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "I'll check." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Bash",
              input: { command: "git status --short", description: "Check repo state" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "user-tool-result",
        toolUseResult: {
          stdout: " M apps/server/src/provider/Layers/ClaudePtyAdapter.ts\n",
          stderr: "",
          interrupted: false,
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: " M apps/server/src/provider/Layers/ClaudePtyAdapter.ts\n",
              is_error: false,
            },
          ],
        },
      }),
      "{partial",
    ].join("\n"),
  );

  assert.deepEqual(events, [
    {
      kind: "assistant_text",
      key: "assistant-tool:text:0",
      uuid: "assistant-tool",
      text: "I'll check.",
      stopReason: "tool_use",
    },
    {
      kind: "tool_use",
      key: "assistant-tool:tool:toolu_123",
      uuid: "assistant-tool",
      toolUseId: "toolu_123",
      toolName: "Bash",
      input: { command: "git status --short", description: "Check repo state" },
    },
    {
      kind: "tool_result",
      key: "user-tool-result:result:toolu_123:0",
      uuid: "user-tool-result",
      toolUseId: "toolu_123",
      content: " M apps/server/src/provider/Layers/ClaudePtyAdapter.ts\n",
      isError: false,
      toolUseResult: {
        stdout: " M apps/server/src/provider/Layers/ClaudePtyAdapter.ts\n",
        stderr: "",
        interrupted: false,
      },
    },
  ]);
});

it.effect("does not stream raw PTY output as assistant text", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudePtyAdapter;

    yield* adapter.startSession({
      provider: "claudePty",
      threadId: asThreadId("thread-pty-output"),
      runtimeMode: "approval-required",
      cwd: "/repo",
    });
    yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
    const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* adapter.sendTurn({
      threadId: asThreadId("thread-pty-output"),
      input: "status",
      attachments: [],
      interactionMode: "default",
    });

    harness.processes[0]?.emitData("\x1b[32mhello\x1b[0m");
    const events = Array.from(yield* Fiber.join(eventsFiber));

    assert.deepEqual(
      events.map((event) => event.type),
      ["turn.started", "session.state.changed"],
    );

    yield* adapter.interruptTurn(asThreadId("thread-pty-output"));
    yield* adapter.stopSession(asThreadId("thread-pty-output"));
  }).pipe(Effect.provide(harness.layer));
});
