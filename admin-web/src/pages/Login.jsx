import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "../api";

export default function LoginPage() {
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await api.login(email, password);
      if (!r.user?.isAdmin) {
        throw new Error("Tài khoản này không phải admin (isAdmin=false)");
      }
      setToken(r.token);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err?.message || "Đăng nhập thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="card" style={{ maxWidth: 560, margin: "44px auto" }}>
        <div className="pageTitle" style={{ marginTop: 0 }}>
          <h2>Đăng nhập quản trị</h2>
          <span className="subtitle">SmartHome</span>
        </div>

        <p className="small" style={{ marginTop: 0 }}>
          Dùng tài khoản có <code>isAdmin=true</code>. Seed mặc định: <b>admin@example.com / admin123</b>
        </p>

        <form onSubmit={submit}>
          <div className="row">
            <div>
              <div className="small">Email</div>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ width: "100%" }}
                autoComplete="username"
              />
            </div>
          </div>

          <div style={{ height: 12 }} />

          <div className="row">
            <div>
              <div className="small">Mật khẩu</div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: "100%" }}
                autoComplete="current-password"
              />
            </div>
          </div>

          <div style={{ height: 16 }} />
          {error ? <div className="error">{error}</div> : null}
          <div style={{ height: 16 }} />

          <button className="primary" type="submit" disabled={loading}>
            {loading ? "Đang đăng nhập..." : "Đăng nhập"}
          </button>
        </form>
      </div>
    </div>
  );
}
