import React, { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, getToken } from "./api";
import Nav from "./components/Nav";

import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import InventoryPage from "./pages/Inventory";
import FleetPage from "./pages/Fleet";
import EventsPage from "./pages/Events";
import CommandsPage from "./pages/Commands";
import AutomationsPage from "./pages/Automations";
import FirmwareReleasesPage from "./pages/FirmwareReleases";
import FirmwareRolloutsPage from "./pages/FirmwareRollouts";
import FirmwareRolloutDetailPage from "./pages/FirmwareRolloutDetail";

function RequireAuth({ children }) {
  const token = getToken();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

export default function App() {
  const [email, setEmail] = useState(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setEmail(null);
      return;
    }

    api
      .me()
      .then((r) => {
        setEmail(r.user?.email || null);
      })
      .catch(() => {
        // token invalid/expired
        setEmail(null);
      });
  }, []);

  const token = getToken();
  return (
    <>
      {token ? <Nav email={email} /> : null}
      <div className="container">
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />

          <Route
            path="/inventory"
            element={
              <RequireAuth>
                <InventoryPage />
              </RequireAuth>
            }
          />

          <Route
            path="/fleet"
            element={
              <RequireAuth>
                <FleetPage />
              </RequireAuth>
            }
          />

          <Route
            path="/events"
            element={
              <RequireAuth>
                <EventsPage />
              </RequireAuth>
            }
          />

          <Route
            path="/commands"
            element={
              <RequireAuth>
                <CommandsPage />
              </RequireAuth>
            }
          />

          <Route
            path="/automations"
            element={
              <RequireAuth>
                <AutomationsPage />
              </RequireAuth>
            }
          />

          <Route
            path="/firmware/releases"
            element={
              <RequireAuth>
                <FirmwareReleasesPage />
              </RequireAuth>
            }
          />

          <Route
            path="/firmware/rollouts"
            element={
              <RequireAuth>
                <FirmwareRolloutsPage />
              </RequireAuth>
            }
          />

          <Route
            path="/firmware/rollouts/:id"
            element={
              <RequireAuth>
                <FirmwareRolloutDetailPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </>
  );
}
