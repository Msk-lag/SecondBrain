import { initClient } from "@ts-rest/core";
import { healthContract } from "@secondbrain/shared";

export const apiClient = initClient(healthContract, {
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
  baseHeaders: {},
});
