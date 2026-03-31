self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  if (!payload || typeof payload.title !== "string") {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" ? payload.tag : undefined,
      data: {
        urlPath: typeof payload.urlPath === "string" ? payload.urlPath : "/",
      },
      badge: "/apple-touch-icon.png",
      icon: "/apple-touch-icon.png",
    }),
  );
});

function normalizePathname(urlString) {
  try {
    return new URL(urlString).pathname;
  } catch {
    return null;
  }
}

function postThreadNavigationMessage(client, urlPath) {
  if ("postMessage" in client) {
    client["postMessage"]({
      type: "thread-completion-notification-clicked",
      urlPath,
    });
  }
}

function broadcastThreadNavigationMessage(clients, urlPath) {
  for (const client of clients) {
    postThreadNavigationMessage(client, urlPath);
  }
}

async function focusOrOpenNotificationTarget(targetUrl, urlPath) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  broadcastThreadNavigationMessage(clients, urlPath);
  const targetPathname = normalizePathname(targetUrl);
  const exactClient =
    targetPathname === null
      ? null
      : clients.find((client) => normalizePathname(client.url) === targetPathname);

  if (exactClient && "focus" in exactClient) {
    if ("navigate" in exactClient) {
      await exactClient.navigate(targetUrl).catch(() => null);
    }
    await exactClient.focus();
    postThreadNavigationMessage(exactClient, urlPath);
    return;
  }

  const windowClient = clients.find((client) => "focus" in client);
  if (windowClient) {
    if ("navigate" in windowClient) {
      await windowClient.navigate(targetUrl).catch(() => null);
    }
    await windowClient.focus();
    postThreadNavigationMessage(windowClient, urlPath);
    return;
  }

  if ("openWindow" in self.clients) {
    const openedClient = await self.clients.openWindow(targetUrl);
    if (openedClient && "focus" in openedClient) {
      await openedClient.focus();
      postThreadNavigationMessage(openedClient, urlPath);
    }
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const urlPath =
    event.notification &&
    event.notification.data &&
    typeof event.notification.data.urlPath === "string"
      ? event.notification.data.urlPath
      : "/";
  const targetUrl = new URL(urlPath, self.location.origin).toString();
  event.waitUntil(focusOrOpenNotificationTarget(targetUrl, urlPath));
});
