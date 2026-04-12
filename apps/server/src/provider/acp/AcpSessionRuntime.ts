import { Effect } from "effect";
import type * as acp from "@agentclientprotocol/sdk";

import type { InitializedAcpClient } from "./AcpClient.ts";

export interface AcpSessionRuntime {
  readonly connection: acp.ClientSideConnection;
  readonly initialize: acp.InitializeResponse;
}

export function makeAcpSessionRuntime(input: InitializedAcpClient): AcpSessionRuntime {
  return {
    connection: input.connection,
    initialize: input.initialize,
  };
}

export const closeAcpSessionRuntime = Effect.fn("closeAcpSessionRuntime")(function* (input: {
  readonly child: { stdin?: { end: () => void } | null; kill: (signal?: NodeJS.Signals) => void };
}) {
  yield* Effect.sync(() => {
    input.child.stdin?.end();
    input.child.kill("SIGTERM");
  });
});
