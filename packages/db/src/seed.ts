import { createDb, createPoolFromEnv } from "./client.js";
import { loadRootEnv } from "./env.js";
import { seedUser } from "./seed-user.js";

async function main(): Promise<void> {
  loadRootEnv();
  const email = process.env.SEED_USER_EMAIL;
  const password = process.env.SEED_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEED_USER_EMAIL and SEED_USER_PASSWORD environment variables are required (set them in .env)",
    );
  }

  const pool = createPoolFromEnv();
  try {
    const db = createDb(pool);
    const result = await seedUser(db, { email, password });
    console.log(`seed user (${email}): ${result}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
