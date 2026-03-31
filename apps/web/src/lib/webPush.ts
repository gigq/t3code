import type { WebPushSubscription } from "@t3tools/contracts";

export const THREAD_COMPLETION_SERVICE_WORKER_URL = "/thread-completion-sw.js";
export const THREAD_COMPLETION_NOTIFICATION_CLICKED_MESSAGE_TYPE =
  "thread-completion-notification-clicked";

export function isWebPushSupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !window.desktopBridge
  );
}

export async function registerThreadCompletionServiceWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(
    THREAD_COMPLETION_SERVICE_WORKER_URL,
    {
      scope: "/",
    },
  );
  await navigator.serviceWorker.ready;
  return registration;
}

export function serializePushSubscription(subscription: PushSubscription): WebPushSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) {
    throw new Error("Push subscription is missing encryption keys.");
  }
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh,
      auth,
    },
  };
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = `${base64String}${padding}`.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(normalized);
  const output = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    output[index] = decoded.charCodeAt(index);
  }
  return output;
}

export function parseThreadIdFromNotificationUrlPath(urlPath: string): string | null {
  const trimmed = urlPath.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 1) {
    return null;
  }
  return segments[0] ?? null;
}
