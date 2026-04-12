import { Data, Effect } from "effect";
import * as acp from "@agentclientprotocol/sdk";

import type { AcpClient } from "./AcpProtocol.ts";

export interface InitializedAcpClient {
  readonly connection: acp.ClientSideConnection;
  readonly initialize: acp.InitializeResponse;
}

class AcpClientInitializeError extends Data.TaggedError("AcpClientInitializeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

export const createAcpClientConnection = Effect.fn("createAcpClientConnection")(function* (input: {
  readonly client: AcpClient;
  readonly stream: acp.Stream;
}) {
  const connection = new acp.ClientSideConnection(() => input.client, input.stream);
  const initialize = yield* Effect.tryPromise({
    try: () =>
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }),
    catch: (cause) =>
      new AcpClientInitializeError({
        cause,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  return {
    connection,
    initialize,
  } satisfies InitializedAcpClient;
});
