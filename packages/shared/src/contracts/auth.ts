import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authErrorSchema = z.object({
  message: z.string(),
});

export const authenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string(),
});

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const authContract = c.router({
  login: {
    method: "POST",
    path: "/auth/login",
    body: loginRequestSchema,
    responses: {
      200: z.object({ accessToken: z.string() }),
      401: authErrorSchema,
    },
  },
  me: {
    method: "GET",
    path: "/auth/me",
    responses: {
      200: authenticatedUserSchema,
      401: authErrorSchema,
    },
  },
});
