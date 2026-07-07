import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const healthContract = c.router({
  getHealth: {
    method: "GET",
    path: "/health",
    responses: {
      200: z.object({
        status: z.literal("ok"),
      }),
    },
  },
});
