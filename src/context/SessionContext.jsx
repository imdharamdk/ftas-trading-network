import { startTransition, useEffect, useState } from "react";
import { SessionContext } from "./sessionContext";
import { apiFetch, clearSession, getStoredToken, getStoredUser, storeSession } from "../lib/api";

export function SessionProvider({ children }) {
  const [token, setToken] = useState(() => getStoredToken());
  const [user, setUser] = useState(() => getStoredUser());
  const [loading, setLoading] = useState(() => Boolean(getStoredToken()));

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    let active = true;

    apiFetch("/auth/me", { token })
      .then((data) => {
        if (!active) {
          return;
        }

        storeSession(token, data.user);

        startTransition(() => {
          setUser(data.user);
          setLoading(false);
        });
      })
      .catch(() => {
        if (!active) {
          return;
        }

        clearSession();

        startTransition(() => {
          setToken("");
          setUser(null);
          setLoading(false);
        });
      });

    return () => {
      active = false;
    };
  }, [token]);

  async function login(credentials) {
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: credentials,
      skipAuth: true,
    });

    storeSession(data.token, data.user);

    startTransition(() => {
      setToken(data.token);
      setUser(data.user);
      setLoading(false);
    });

    return data.user;
  }

  async function register(payload) {
    const data = await apiFetch("/auth/register", {
      method: "POST",
      body: payload,
      skipAuth: true,
    });

    storeSession(data.token, data.user);

    startTransition(() => {
      setToken(data.token);
      setUser(data.user);
      setLoading(false);
    });

    return data.user;
  }

  function logout() {
    clearSession();

    startTransition(() => {
      setToken("");
      setUser(null);
      setLoading(false);
    });
  }

  async function refreshUser() {
    if (!token) {
      return null;
    }

    const data = await apiFetch("/auth/me", { token });
    storeSession(token, data.user);

    startTransition(() => {
      setUser(data.user);
    });

    return data.user;
  }

  return (
    <SessionContext.Provider
      value={{
        loading,
        login,
        logout,
        refreshUser,
        register,
        token,
        user,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
