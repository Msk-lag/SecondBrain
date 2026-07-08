import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "./schema/index.js";
import { dbConnectionOptionsFromEnv, loadRootEnv, type DbConnectionOptions } from "./env.js";

export type Database = MySql2Database<typeof schema>;

export function createPool(options: DbConnectionOptions): Pool {
  return mysql.createPool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    connectionLimit: 10,
  });
}

export function createPoolFromEnv(): Pool {
  loadRootEnv();
  return createPool(dbConnectionOptionsFromEnv());
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema, mode: "default" });
}
