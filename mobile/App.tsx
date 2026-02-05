import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "./src/auth/AuthContext";
import AppNavigator from "./src/navigation/AppNavigator";
import { SseProvider } from "./src/realtime/SseProvider";
import { HomeProvider } from "./src/context/HomeContext";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <HomeProvider>
          <SseProvider>
            <AppNavigator />
          </SseProvider>
        </HomeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
