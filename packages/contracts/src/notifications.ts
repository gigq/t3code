import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const WebPushSubscriptionKeys = Schema.Struct({
  p256dh: TrimmedNonEmptyString,
  auth: TrimmedNonEmptyString,
});
export type WebPushSubscriptionKeys = typeof WebPushSubscriptionKeys.Type;

export const WebPushSubscription = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  expirationTime: Schema.NullOr(Schema.Number),
  keys: WebPushSubscriptionKeys,
});
export type WebPushSubscription = typeof WebPushSubscription.Type;

export const RemoveWebPushSubscriptionInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
});
export type RemoveWebPushSubscriptionInput = typeof RemoveWebPushSubscriptionInput.Type;

export const WebPushConfig = Schema.Struct({
  vapidPublicKey: TrimmedNonEmptyString,
});
export type WebPushConfig = typeof WebPushConfig.Type;

export class WebPushRpcError extends Schema.TaggedErrorClass<WebPushRpcError>()("WebPushRpcError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const ThreadCompletionNotificationPayload = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  tag: TrimmedNonEmptyString,
  urlPath: TrimmedNonEmptyString,
});
export type ThreadCompletionNotificationPayload = typeof ThreadCompletionNotificationPayload.Type;
