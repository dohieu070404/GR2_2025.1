import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { setToken } from "../api";

export default function Nav({ email }) {
  const navigate = useNavigate();

  return (
    <div className="nav">
      <b>Quản trị SmartHome</b>

      <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
        Tổng quan
      </NavLink>
      <NavLink to="/inventory" className={({ isActive }) => (isActive ? "active" : "")}>
        Tồn kho
      </NavLink>
      <NavLink to="/fleet" className={({ isActive }) => (isActive ? "active" : "")}>
        Đội thiết bị
      </NavLink>
      <NavLink to="/events" className={({ isActive }) => (isActive ? "active" : "")}>
        Sự kiện
      </NavLink>
      <NavLink to="/commands" className={({ isActive }) => (isActive ? "active" : "")}>
        Lệnh
      </NavLink>
      <NavLink to="/automations" className={({ isActive }) => (isActive ? "active" : "")}>
        Tự động hóa
      </NavLink>
      <NavLink to="/firmware/releases" className={({ isActive }) => (isActive ? "active" : "")}>
        Phát hành FW
      </NavLink>
      <NavLink to="/firmware/rollouts" className={({ isActive }) => (isActive ? "active" : "")}>
        Triển khai FW
      </NavLink>

      <div className="right">
        <span className="small">{email || ""}</span>
        <button
          onClick={() => {
            setToken(null);
            navigate("/login");
          }}
        >
          Đăng xuất
        </button>
      </div>
    </div>
  );
}
