import type { ChatAttachment, ThreadId } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ReplayTranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ReplayTranscript {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly turns: ReadonlyArray<ReplayTranscriptTurn>;
}

export interface ProviderReplayTranscriptShape {
  readonly readTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<ReplayTranscript, ProjectionRepositoryError | Error>;
}

export class ProviderReplayTranscript extends ServiceMap.Service<
  ProviderReplayTranscript,
  ProviderReplayTranscriptShape
>()("t3/provider/Services/ProviderReplayTranscript") {}
