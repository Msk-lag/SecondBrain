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
    // options.ssl が undefined なら mysql2 の既定(TLS 無し)のまま。RDS for MariaDB 11.8
    // 対応(require_secure_transport 既定 1)は options.ssl(env.ts の sslOptionsFromEnv 参照)
    // の設定で有効化する(M1-4b 計画 §設計決定12)。
    ssl: options.ssl,
  });
}

export function createPoolFromEnv(): Pool {
  loadRootEnv();
  return createPool(dbConnectionOptionsFromEnv());
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema, mode: "default" });
}
