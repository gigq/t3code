import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { Data, Effect } from "effect";
import * as acp from "@agentclientprotocol/sdk";

export interface AcpProcessHandle {
  readonly child: ChildProcess;
  readonly stream: acp.Stream;
}

class AcpProcessStartError extends Data.TaggedError("AcpProcessStartError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

export const startAcpProcess = Effect.fn("startAcpProcess")(function* (input: {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}) {
  const child = yield* Effect.try({
    try: () =>
      spawn(input.binaryPath, input.args ?? ["--acp", "--stdio"], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    catch: (cause) =>
      new AcpProcessStartError({
        cause,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  if (!child.stdin || !child.stdout) {
    return yield* Effect.fail(new Error("Failed to start ACP process with piped stdio."));
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inputStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;

  return {
    child,
    stream: acp.ndJsonStream(output, inputStream),
  } satisfies AcpProcessHandle;
});
