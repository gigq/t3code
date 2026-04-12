import { Effect, Layer } from "effect";
import { Option } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderReplayTranscript,
  type ProviderReplayTranscriptShape,
} from "../Services/ProviderReplayTranscript.ts";

const makeProviderReplayTranscript = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  return {
    readTranscript: Effect.fn("ProviderReplayTranscript.readTranscript")(function* (threadId) {
      const replayContext = yield* projectionSnapshotQuery.getThreadReplayContext(threadId);
      if (Option.isNone(replayContext)) {
        return yield* Effect.fail(new Error(`Unknown thread '${threadId}'.`));
      }

      return {
        threadId,
        cwd: replayContext.value.cwd,
        turns: replayContext.value.turns,
      };
    }),
  } satisfies ProviderReplayTranscriptShape;
});

export const ProviderReplayTranscriptLive = Layer.effect(
  ProviderReplayTranscript,
  makeProviderReplayTranscript,
);
