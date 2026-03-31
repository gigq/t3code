import { useCallback, useEffect, useState } from "react";
import { ensureNativeApi } from "../nativeApi";
import {
  isWebPushSupported,
  registerThreadCompletionServiceWorker,
  serializePushSubscription,
  urlBase64ToUint8Array,
} from "../lib/webPush";

export interface ThreadCompletionNotificationsState {
  readonly isSupported: boolean;
  readonly isBusy: boolean;
  readonly hasSubscription: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly error: string | null;
  readonly enable: () => Promise<void>;
  readonly disable: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export function useThreadCompletionNotifications(): ThreadCompletionNotificationsState {
  const supported = isWebPushSupported();
  const [isBusy, setIsBusy] = useState(false);
  const [hasSubscription, setHasSubscription] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    supported ? getNotificationPermission() : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supported) {
      setPermission("unsupported");
      setHasSubscription(false);
      setError(null);
      return;
    }

    try {
      const registration = await registerThreadCompletionServiceWorker();
      const subscription = await registration.pushManager.getSubscription();
      setPermission(getNotificationPermission());
      setHasSubscription(subscription !== null);
      setError(null);
    } catch (refreshError) {
      setPermission(getNotificationPermission());
      setHasSubscription(false);
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Could not read notification subscription state.",
      );
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!supported) {
      throw new Error("Web Push notifications are not supported in this environment.");
    }

    setIsBusy(true);
    setError(null);

    try {
      const registration = await registerThreadCompletionServiceWorker();
      let nextPermission = getNotificationPermission();
      if (nextPermission !== "granted") {
        nextPermission = await Notification.requestPermission();
      }

      setPermission(nextPermission);
      if (nextPermission !== "granted") {
        setHasSubscription(false);
        return;
      }

      const api = ensureNativeApi();
      const { vapidPublicKey } = await api.notifications.getWebPushConfig();
      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        }));

      await api.notifications.upsertWebPushSubscription(serializePushSubscription(subscription));
      setHasSubscription(true);
    } catch (enableError) {
      const message =
        enableError instanceof Error ? enableError.message : "Could not enable notifications.";
      setError(message);
      throw enableError;
    } finally {
      setIsBusy(false);
    }
  }, [supported]);

  const disable = useCallback(async () => {
    if (!supported) {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await ensureNativeApi().notifications.removeWebPushSubscription({
          endpoint: subscription.endpoint,
        });
        await subscription.unsubscribe().catch(() => false);
      }
      setPermission(getNotificationPermission());
      setHasSubscription(false);
    } catch (disableError) {
      const message =
        disableError instanceof Error ? disableError.message : "Could not disable notifications.";
      setError(message);
      throw disableError;
    } finally {
      setIsBusy(false);
    }
  }, [supported]);

  return {
    isSupported: supported,
    isBusy,
    hasSubscription,
    permission,
    error,
    enable,
    disable,
    refresh,
  };
}
