import type {
  RemoveWebPushSubscriptionInput,
  ThreadCompletionNotificationPayload,
  WebPushConfig,
  WebPushSubscription,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";

export class WebPushServiceError extends Schema.TaggedErrorClass<WebPushServiceError>()(
  "WebPushServiceError",
  {
    detail: Schema.String,
    statePath: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Web Push service error at ${this.statePath}: ${this.detail}`;
  }
}

export interface WebPushServiceShape {
  readonly start: Effect.Effect<void, WebPushServiceError>;
  readonly getWebPushConfig: Effect.Effect<WebPushConfig, WebPushServiceError>;
  readonly upsertWebPushSubscription: (
    input: WebPushSubscription,
  ) => Effect.Effect<void, WebPushServiceError>;
  readonly removeWebPushSubscription: (
    input: RemoveWebPushSubscriptionInput,
  ) => Effect.Effect<void, WebPushServiceError>;
  readonly sendThreadCompletionNotification: (
    payload: ThreadCompletionNotificationPayload,
  ) => Effect.Effect<void, never>;
}

export class WebPushService extends ServiceMap.Service<WebPushService, WebPushServiceShape>()(
  "t3/notifications/Services/WebPushService",
) {
  static readonly layerTest = Layer.succeed(WebPushService, {
    start: Effect.void,
    getWebPushConfig: Effect.succeed({ vapidPublicKey: "test-vapid-public-key" }),
    upsertWebPushSubscription: () => Effect.void,
    removeWebPushSubscription: () => Effect.void,
    sendThreadCompletionNotification: () => Effect.void,
  } satisfies WebPushServiceShape);
}
