import { describe, expect, it } from "vitest";
import { serializePushSubscription, urlBase64ToUint8Array } from "./webPush";

describe("webPush helpers", () => {
  it("converts URL-safe base64 VAPID keys to Uint8Array", () => {
    const bytes = urlBase64ToUint8Array("SGVsbG8");
    expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
  });

  it("serializes push subscriptions from the browser shape", () => {
    const subscription = {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      toJSON: () => ({
        endpoint: "https://push.example/subscription",
        expirationTime: null,
        keys: {
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      }),
    } as unknown as PushSubscription;

    expect(serializePushSubscription(subscription)).toEqual({
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh-key",
        auth: "auth-key",
      },
    });
  });

  it("rejects subscriptions that do not expose encryption keys", () => {
    const subscription = {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      toJSON: () => ({
        endpoint: "https://push.example/subscription",
        expirationTime: null,
        keys: {},
      }),
    } as unknown as PushSubscription;

    expect(() => serializePushSubscription(subscription)).toThrow(
      "Push subscription is missing encryption keys.",
    );
  });
});
