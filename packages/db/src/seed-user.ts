import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { Database } from "./client.js";
import { users } from "./schema/users.js";

export type SeedResult = "created" | "skipped";

/**
 * MariaDB の一意制約違反(email の UNIQUE)を成功扱いにするための判定。
 * 事前チェックとの間に他プロセスが挿入した場合の競合も冪等に吸収する。
 */
export function isDuplicateEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

export async function seedUser(
  db: Database,
  input: { email: string; password: string },
): Promise<SeedResult> {
  const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  if (existing.length > 0) {
    return "skipped";
  }
  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    await db.insert(users).values({ id: randomUUID(), email: input.email, passwordHash });
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      return "skipped";
    }
    throw error;
  }
  return "created";
}
