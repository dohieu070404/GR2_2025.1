import React from "react";
import { useAuth } from "../auth/AuthContext";
import { useSseEvents } from "./useSseEvents";

export function SseProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();

  // Start/stop SSE stream based on auth token.
  useSseEvents(token);

  return <>{children}</>;
}
