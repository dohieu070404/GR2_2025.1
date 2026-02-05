import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { setAuthToken } from "../api/client";
import { apiLogin, apiMe, apiRegister, apiLogout } from "../api/api";
import type { User } from "../types";

type AuthContextValue = {
  isBootstrapping: boolean;
  token: string | null;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "smarthome_token_v1";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  async function persistToken(nextToken: string | null) {
    if (nextToken) {
      await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (stored) {
          setAuthToken(stored);
          setToken(stored);
          const me = await apiMe();
          setUser(me.user);
        }
      } catch (e) {
        // token invalid or server unreachable
        await persistToken(null);
        setAuthToken(null);
        setToken(null);
        setUser(null);
      } finally {
        setIsBootstrapping(false);
      }
    })();
  }, []);

  async function login(email: string, password: string) {
    const res = await apiLogin({ email, password });
    setAuthToken(res.token);
    setToken(res.token);
    setUser(res.user);
    await persistToken(res.token);
  }

  async function register(name: string, email: string, password: string) {
    const res = await apiRegister({ name, email, password });
    setAuthToken(res.token);
    setToken(res.token);
    setUser(res.user);
    await persistToken(res.token);
  }

  async function logout() {
    try {
      await apiLogout();
    } catch {
      // ignore
    }
    setAuthToken(null);
    setToken(null);
    setUser(null);
    await persistToken(null);
  }

  const value = useMemo<AuthContextValue>(
    () => ({ isBootstrapping, token, user, login, register, logout }),
    [isBootstrapping, token, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
