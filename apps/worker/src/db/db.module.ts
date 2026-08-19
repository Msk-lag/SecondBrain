import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import mysql from "mysql2/promise";
import { createDb, dbConnectionOptionsFromEnv, loadRootEnv, type Database } from "@secondbrain/db";

export const DRIZZLE = "DRIZZLE";
export const MYSQL_POOL = "MYSQL_POOL";

/**
 * mysql2/promise の型定義には無いが実行時には存在する `Connection.prototype.promise()`
 * (mysql2/lib/pool_connection.js 参照)にアクセスするための最小限の型。
 */
interface RawPoolConnectionWithPromise {
  promise(): { query(sql: string): Promise<unknown> };
  destroy(): void;
}

// packages/db の createPool と同じ接続上限を維持する(既存の接続上限を変更しない)。
// apps/api/src/db/db.module.ts と同じ値を個別に設定する。
const CONNECTION_LIMIT = 10;
// ハングしたクエリを DB 側でも打ち切る秒数(小数点以下も指定可能な MariaDB 固有のセッション変数)。
// § DB クエリのハングに対する対策 参照。apps/api 側の db.module.ts にも同じ値を個別に設定済み。
const MAX_STATEMENT_TIME_SECONDS = 8;

/**
 * worker はこれまで DB 未接続だったため新規に接続プールを構築する。
 * apps/api/src/db/db.module.ts と同等のパターン(§ 接続プール自体の待機キューを有限にする・
 * Codex レビュー r29 指摘 [1]・r30 指摘 [1] 参照。共有プールファクトリの実在は未確認のため、
 * api/worker それぞれの db.module.ts へ個別に設定する):
 * - waitForConnections: true・queueLimit: 接続待ちキュー自体を有限にする(既定値 0 は無制限)
 * - コネクション生成のたびに SET SESSION max_statement_time を実行し、DB 側でもハングした
 *   クエリを打ち切る
 */
/** テスト用にエクスポートする(Codex コードレビュー 2026-07-13 r7 指摘 [A-2] の回帰テストで使用)。 */
export function createWorkerPool(): mysql.Pool {
  loadRootEnv();
  const options = dbConnectionOptionsFromEnv();
  const pool = mysql.createPool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    // TLS(M1-4b §設計決定12)。api 側の db.module.ts と同じ理由・同じ扱い
    // (`dbConnectionOptionsFromEnv()` の値をそのまま渡す。未設定なら undefined = TLS 無し)。
    // packages/db の createPool() はこの関数から呼ばれていないため、そちらへの追加だけでは
    // worker の実行時プールに TLS が効かない。
    ssl: options.ssl,
    connectionLimit: CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: CONNECTION_LIMIT,
  });
  pool.on("connection", (connection) => {
    // mysql2/promise の Pool は "connection" イベントを内部の callback 版 core pool から
    // そのまま転送するため、ハンドラに渡ってくるのは promise 版ではなく生の(callback 版)
    // Connection である。生の Connection.query() は Promise を返さないため、`.promise()` で
    // 明示的に promise 版へラップしてから呼び出す(apps/api/src/db/db.module.ts と同じ修正)。
    // セッション変数設定に失敗した接続を、保護(max_statement_time)の無いままプールへ
    // 戻すと、その接続がハングしたクエリを引いた際にアプリ側の Promise.race による
    // タイムアウトでは実クエリを中断できず、接続がプールへ返却されないままプール全体が
    // 徐々に枯渇しうる(Codex コードレビュー 2026-07-13 r7 指摘 [A-2] への対応。apps/api
    // 側の同種修正と同一パターン)。設定に失敗した接続は `destroy()` してプールから除外する
    // (次回の取得時、mysql2 が新しい接続を生成し直す。致命的ではないため呼び出し元へは
    // 伝播させない)。接続情報を含みうる生のエラーはログに出さない。
    (connection as unknown as RawPoolConnectionWithPromise)
      .promise()
      .query(`SET SESSION max_statement_time = ${MAX_STATEMENT_TIME_SECONDS}`)
      .catch(() => {
        (connection as unknown as RawPoolConnectionWithPromise).destroy();
      });
  });
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: MYSQL_POOL,
      useFactory: (): mysql.Pool => createWorkerPool(),
    },
    {
      provide: DRIZZLE,
      useFactory: (pool: mysql.Pool): Database => createDb(pool),
      inject: [MYSQL_POOL],
    },
  ],
  exports: [DRIZZLE],
})
// Pool を独立した provider として保持し、モジュール破棄時に確実に `pool.end()` を呼ぶ
// (Codex コードレビュー r7 指摘 [A-3] への対応。以前は Pool の参照がどこにも保持されず、
// `app.close()` 等の正常なシャットダウンでも接続が残留していた)。
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(MYSQL_POOL) private readonly pool: mysql.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
