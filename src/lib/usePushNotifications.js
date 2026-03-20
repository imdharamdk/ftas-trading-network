/**
 * usePushNotifications — FTAS Browser Push Notifications
 *
 * Registers service worker, requests permission, subscribes to push.
 * Backend pe subscription store hoti hai — signal generate hone pe push bheja jaata hai.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";

export function usePushNotifications() {
  const [permission, setPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const [subscribed, setSubscribed]   = useState(false);
  const [supported, setSupported]     = useState(false);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const swReg = useRef(null);

  // Check support + register SW on mount
  useEffect(() => {
    const isSecure = typeof window !== "undefined" && (window.isSecureContext || window.location.hostname === "localhost");
    if (!isSecure) {
      setSupported(false);
      setError("Push notifications require HTTPS (or localhost).");
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      setError("Your browser doesn't support push notifications.");
      return;
    }
    setSupported(true);

    navigator.serviceWorker.register("/sw.js")
      .then((reg) => {
        swReg.current = reg;
        setError("");
        // Check if already subscribed
        return reg.pushManager.getSubscription();
      })
      .then((sub) => {
        setSubscribed(!!sub);
      })
      .catch((err) => {
        const msg = err?.message || "Service worker registration failed";
        console.warn("[push] SW registration failed:", msg);
        setError(msg);
      });
  }, []);

  // Request permission + subscribe
  const subscribe = useCallback(async () => {
    if (!supported || !swReg.current) return;
    setLoading(true);
    setError("");
    try {
      // Request permission
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setError("Notification permission denied. Enable it in browser settings.");
        return;
      }

      // Get VAPID public key from backend
      const { publicKey } = await apiFetch("/notifications/vapid-public-key");

      // Subscribe to push
      const sub = await swReg.current.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // Send subscription to backend
      await apiFetch("/notifications/subscribe", {
        method: "POST",
        body: { subscription: sub.toJSON() },
      });

      setSubscribed(true);
    } catch (err) {
      setError(err.message || "Failed to enable notifications");
    } finally {
      setLoading(false);
    }
  }, [supported]);

  // Unsubscribe
  const unsubscribe = useCallback(async () => {
    if (!swReg.current) return;
    setLoading(true);
    try {
      const sub = await swReg.current.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await apiFetch("/notifications/unsubscribe", { method: "POST" });
      }
      setSubscribed(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Local notification (no push — just browser notification directly)
  // Used when app is open and WS/SSE sends a new signal
  const showLocal = useCallback((title, body, url = "/crypto") => {
    if (permission !== "granted") return;
    try {
      new Notification(title, {
        body,
        icon: "/vite.svg",
        tag: "ftas-local",
        data: { url },
      });
    } catch {}
  }, [permission]);

  return { permission, subscribed, supported, loading, error, subscribe, unsubscribe, showLocal };
}

// Helper: convert VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw     = window.atob(base64);
  return new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
}
