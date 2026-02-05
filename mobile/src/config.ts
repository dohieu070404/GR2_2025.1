// Runtime configuration for the mobile app.
//
// ✅ Recommended (dev/staging/prod):
//   Set EXPO_PUBLIC_API_URL in `mobile/.env` (or EAS env), e.g.
//     EXPO_PUBLIC_API_URL=http://192.168.1.10:3000
//
// ⚠️ Common pitfall:
//   On a real phone or Android emulator, `localhost` is NOT your PC.
//   - Android emulator: use 10.0.2.2 (host machine)
//   - Real device: use your PC's LAN IP (same Wi‑Fi)
//
// To reduce setup friction in dev-client, we also try to auto-detect the
// Metro host IP and assume backend runs on the same host.

import { NativeModules, Platform } from "react-native";

function normalizeBaseUrl(url: string): string {
  const trimmed = (url || "").trim();
  // Remove trailing slashes to avoid double slashes in requests.
  return trimmed.replace(/\/+$/, "");
}

function ensureHttpScheme(url: string): string {
  const s = (url || "").trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return `http://${s}`;
}

export const APP_ENV = (process.env.EXPO_PUBLIC_APP_ENV || "dev").toLowerCase();

function getMetroHost(): string | null {
  // React Native dev builds expose the Metro bundle URL via NativeModules.SourceCode.scriptURL.
  // Example:
  //   http://192.168.2.2:8081/index.bundle?platform=android&dev=true&minify=false
  const scriptURL = (NativeModules as any)?.SourceCode?.scriptURL as string | undefined;
  if (!scriptURL || typeof scriptURL !== "string") return null;

  const m = scriptURL.match(/^https?:\/\/([^:\/]+)(?::\d+)?\//);
  if (!m) return null;
  const host = m[1];
  if (!host || host === "localhost" || host === "127.0.0.1") return null;
  return host;
}

function replaceLocalhostIfNeeded(urlWithScheme: string): string {
  // Rewrite `localhost` when running on device/emulator to something reachable.
  // Strategy:
  // - Prefer Metro host IP (works for real devices + emulator)
  // - Else on Android, use 10.0.2.2
  // - Else keep localhost
  const s = (urlWithScheme || "").trim();
  const m = s.match(/^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i);
  if (!m) return s;

  const scheme = m[1];
  const port = m[3] || "";
  const rest = m[4] || "";

  const metroHost = getMetroHost();
  if (metroHost) return `${scheme}${metroHost}${port}${rest}`;

  if (Platform.OS === "android") return `${scheme}10.0.2.2${port}${rest}`;
  return s;
}

function defaultApiUrlForEnv(env: string): string {
  // Keep consistent with backend default PORT=3000
  const defaultPort = 3000;

  if (env === "dev") {
    // Best dev experience: infer host from Metro (works in Expo dev-client).
    const metroHost = getMetroHost();
    if (metroHost) return `http://${metroHost}:${defaultPort}`;

    // Fallbacks
    if (Platform.OS === "android") return `http://10.0.2.2:${defaultPort}`;
    return `http://localhost:${defaultPort}`;
  }

  // staging/prod should set EXPO_PUBLIC_API_URL explicitly.
  // Still fall back to localhost to avoid crashing dev builds.
  if (Platform.OS === "android") return `http://10.0.2.2:${defaultPort}`;
  return `http://localhost:${defaultPort}`;
}

const rawFromEnv = (process.env.EXPO_PUBLIC_API_URL || "").trim();
const rawApiUrl = rawFromEnv || defaultApiUrlForEnv(APP_ENV);

// Base backend URL (no trailing slash)
export const API_URL = normalizeBaseUrl(replaceLocalhostIfNeeded(ensureHttpScheme(rawApiUrl)));
