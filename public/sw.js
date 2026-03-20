/* FTAS service worker for push notifications */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "FTAS Signal";
  const body = data.body || "";
  const url = data.url || "/crypto";
  const tag = data.tag || "ftas-push";

  const options = {
    body,
    icon: "/vite.svg",
    badge: "/vite.svg",
    tag,
    data: { url },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/crypto";
  const target = new URL(url, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === target) {
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
