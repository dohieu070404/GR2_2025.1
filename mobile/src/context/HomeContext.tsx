import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";

export type HomeSelection = {
  isHydrated: boolean;
  activeHomeId: number | null;
  setActiveHomeId: (id: number | null) => void;
  activeRoomId: number | null;
  setActiveRoomId: (id: number | null) => void;
};

const Ctx = createContext<HomeSelection | null>(null);

export function HomeProvider({ children }: { children: React.ReactNode }) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [activeHomeId, setActiveHomeId] = useState<number | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null);

  const HOME_KEY = "smarthome_active_home_v1";
  const ROOM_KEY = "smarthome_active_room_v1";

  useEffect(() => {
    (async () => {
      try {
        const [h, r] = await Promise.all([
          SecureStore.getItemAsync(HOME_KEY),
          SecureStore.getItemAsync(ROOM_KEY),
        ]);
        const homeId = h ? Number(h) : null;
        const roomId = r ? Number(r) : null;

        if (Number.isInteger(homeId)) setActiveHomeId(homeId as number);
        if (Number.isInteger(roomId)) setActiveRoomId(roomId as number);
      } catch {
        // ignore
      } finally {
        setIsHydrated(true);
      }
    })();
  }, []);

  // Persist selection (best-effort)
  useEffect(() => {
    if (!isHydrated) return;
    (async () => {
      try {
        if (activeHomeId == null) await SecureStore.deleteItemAsync(HOME_KEY);
        else await SecureStore.setItemAsync(HOME_KEY, String(activeHomeId));

        if (activeRoomId == null) await SecureStore.deleteItemAsync(ROOM_KEY);
        else await SecureStore.setItemAsync(ROOM_KEY, String(activeRoomId));
      } catch {
        // ignore
      }
    })();
  }, [activeHomeId, activeRoomId, isHydrated]);

  const value = useMemo<HomeSelection>(
    () => ({
      isHydrated,
      activeHomeId,
      setActiveHomeId: (id) => {
        setActiveHomeId(id);
        // Reset room filter when switching home
        setActiveRoomId(null);
      },
      activeRoomId,
      setActiveRoomId,
    }),
    [activeHomeId, activeRoomId, isHydrated]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHomeSelection(): HomeSelection {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHomeSelection must be used within HomeProvider");
  return v;
}
