import axios from "axios";
import { API_URL } from "../config";

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export const http = axios.create({
  baseURL: API_URL,
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  if (authToken) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${authToken}`;
  }
  return config;
});
