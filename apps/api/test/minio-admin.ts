import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 統合テストの `integration-setup.ts` から、`docker-compose.yml` の `minio-init` サービスと
 * 同じ `minio/mc` イメージを使い捨てコンテナで呼び出すためのヘルパー(§ テスト用 MinIO 資格情報の
 * 方針・「mc 管理コマンドの実行手段」参照)。ローカル環境に `mc` バイナリのインストールを前提にせず、
 * `child_process.spawn`(シェル文字列を組み立てず引数配列を渡す)+ `-e` フラグでの環境変数渡しで
 * 呼び出す。秘密値はコマンドライン引数に含めない(spawn の `env` オプション経由で渡す)。
 */

const MC_IMAGE = "minio/mc:RELEASE.2025-08-13T08-35-41Z";
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SCRIPTS_DIR = resolve(REPO_ROOT, "scripts");

// コンテナ内から見た MinIO のエンドポイント(Compose のサービス名解決。ホスト側プロセスが使う
// MINIO_HOST=localhost とは別。docker-compose.yml の minio-init と同じ値)。
export const MC_CONTAINER_ENDPOINT = "http://minio:9000";
export const MC_ALIAS = "local";

/**
 * Compose ネットワーク名の取得(実装時に確定・§ テスト用 MinIO 資格情報の方針 参照)。
 * `docker-compose.yml` に明示的な `name:` が無いため、Compose は既定でプロジェクトディレクトリ
 * 名(小文字化・`[a-z0-9_-]` 以外除去)をプロジェクト名として使い、ネットワーク名は
 * `<プロジェクト名>_default` になる。環境によってプロジェクト名が異なる場合に備え、
 * `MINIO_MC_DOCKER_NETWORK` 環境変数で明示上書きできるようにする。
 */
export function mcDockerNetworkName(): string {
  const override = process.env.MINIO_MC_DOCKER_NETWORK;
  if (override) {
    return override;
  }
  const projectName = basename(REPO_ROOT)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return `${projectName}_default`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required but not set`);
  }
  return value;
}

function runDocker(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new Error(`docker spawn failed: ${err instanceof Error ? err.message : String(err)}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      // 秘密値はこの stderr に写り込まない(スクリプト自身が秘密値を出力しない設計。
      // § テスト用 MinIO 資格情報の方針 参照)。
      reject(new Error(`docker command exited with code ${code}: ${stderr.slice(0, 2000)}`));
    });
  });
}

/**
 * `scripts/minio-app-policy.sh` / `scripts/minio-app-policy-cleanup.sh` を使い捨てコンテナから
 * 呼び出す。位置引数は秘密値を含まない。秘密値は `MC_ROOT_USER`/`MC_ROOT_PASSWORD`/
 * `MC_APP_SECRET_KEY` として `spawn` の `env` 経由・`-e VAR`(値省略形)でコンテナへ渡す。
 */
export async function runMinioAppPolicyScript(
  scriptFileName: "minio-app-policy.sh" | "minio-app-policy-cleanup.sh",
  positionalArgs: [bucketName: string, appAccessKey: string, policyName: string],
  appSecretKey: string,
): Promise<void> {
  const [bucketName, appAccessKey, policyName] = positionalArgs;
  const scriptArgs = [MC_CONTAINER_ENDPOINT, MC_ALIAS, appAccessKey, bucketName, policyName];
  await runDocker(
    [
      "run",
      "--rm",
      "--network",
      mcDockerNetworkName(),
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${SCRIPTS_DIR}:/scripts:ro`,
      "-e",
      "MC_ROOT_USER",
      "-e",
      "MC_ROOT_PASSWORD",
      "-e",
      "MC_APP_SECRET_KEY",
      MC_IMAGE,
      `/scripts/${scriptFileName}`,
      ...scriptArgs,
    ],
    {
      MC_ROOT_USER: requireEnv("MINIO_ROOT_USER"),
      MC_ROOT_PASSWORD: requireEnv("MINIO_ROOT_PASSWORD"),
      MC_APP_SECRET_KEY: appSecretKey,
    },
  );
}

/**
 * root 資格情報で任意の `mc` コマンド列を1つの使い捨てコンテナ内で実行する(alias set は
 * 使い捨てコンテナ内で完結させる必要があるため、同一コンテナ内でまとめて実行する)。
 * `mcCommands` は `mc alias set` 済みの alias(`local`)を前提にした後続コマンドの配列。
 */
// `MC_HOST_<alias>` 環境変数方式は資格情報のURLエンコードが必要になり、r6([B-1]・[E-2]:
// 未エンコードによる実害)・r7([B-2]:過剰な事前検証による有効な資格情報の拒否)と
// 2ラウンド連続で問題が発生したため `mc alias set` へ差し戻す(Codex コードレビュー r7
// 指摘 [B-2] への対応。scripts/minio-app-policy.sh 冒頭のコメントと同じ方針)。
// 秘密値は `spawn` の `env` オプション経由で渡し、プロセス引数には含めない(使い捨て
// コンテナ内でのみ一時的にプロセス引数へ現れる点は既知の残存リスクとして受容)。
const MC_ALIAS_SET_LINE = `mc alias set ${MC_ALIAS} ${MC_CONTAINER_ENDPOINT} "$MC_ROOT_USER" "$MC_ROOT_PASSWORD"`;

async function runRootMcCommands(mcCommands: string[]): Promise<string> {
  const script = [MC_ALIAS_SET_LINE, ...mcCommands].join(" && ");

  return runDocker(
    [
      "run",
      "--rm",
      "--network",
      mcDockerNetworkName(),
      "--entrypoint",
      "/bin/sh",
      "-e",
      "MC_ROOT_USER",
      "-e",
      "MC_ROOT_PASSWORD",
      MC_IMAGE,
      "-c",
      script,
    ],
    {
      MC_ROOT_USER: requireEnv("MINIO_ROOT_USER"),
      MC_ROOT_PASSWORD: requireEnv("MINIO_ROOT_PASSWORD"),
    },
  );
}

/**
 * バケットの匿名アクセスを意図的に許可状態にする(§ 匿名アクセス拒否の検証 手順1 参照。
 * 既存の公開状態からの収束を検証するため、`minio-app-policy.sh`(`mc anonymous set none` を
 * 含む)を実行する前に呼ぶ)。
 */
export async function setAnonymousDownload(bucketName: string): Promise<void> {
  await runRootMcCommands([`mc anonymous set download ${MC_ALIAS}/${bucketName}`]);
}

/**
 * バケットの匿名アクセス設定を取得する(§ 匿名アクセス拒否の検証 手順4 参照。
 * `minio-app-policy.sh` 実行後、`none` に収束していることを確認するために使う)。
 */
export async function getAnonymousStatus(bucketName: string): Promise<string> {
  const stdout = await runRootMcCommands([`mc anonymous get ${MC_ALIAS}/${bucketName}`]);
  return stdout.trim();
}

/**
 * `mc mb --ignore-existing` でバケットを作成する(root 資格情報。テスト分離の方針 参照。
 * 呼び出し前に中身を空にしてから使うのは呼び出し元の責務)。
 */
export async function createBucketIfMissing(bucketName: string): Promise<void> {
  await runRootMcCommands([`mc mb --ignore-existing ${MC_ALIAS}/${bucketName}`]);
}

/**
 * `mc rb --force`(存在しなければ無視)でバケットを中身ごと削除する(root 資格情報)。
 * 以前は `2>/dev/null || true` で終了コードを問わず常に成功扱いにしており、認証エラー・
 * ネットワーク障害等の「バケット不在」以外の失敗も握り潰していた。削除できなかった既存
 * バケット・オブジェクトが残ったまま後続の `mc mb --ignore-existing` でテストが続行され、
 * テスト分離が保証されなくなる(Codex コードレビュー 2026-07-13 r5 指摘 [A-2] への対応)。
 * `scripts/minio-app-policy-cleanup.sh` の `is_not_found_error()` と同じ判定基準で、
 * バケット不在エラーのみを無視し、それ以外の失敗は呼び出し元へ伝播させる。
 * (`is_not_found_error()` と同様、部分文字列一致のため理論上は無関係なエラーメッセージが
 * 偶然「does not exist」を含む場合に誤判定しうるが、`MC_ROOT_USER`/`MC_ROOT_PASSWORD` は
 * `requireEnv()` で必ず正しい値が渡るため実際には発生しない、既存の残存リスクと同種)。
 */
export async function removeBucketIfExists(bucketName: string): Promise<void> {
  await runRootMcCommands([
    `RB_OUTPUT="$(mc rb --force ${MC_ALIAS}/${bucketName} 2>&1)"; RB_EXIT=$?; ` +
      `if [ "$RB_EXIT" -ne 0 ]; then case "$RB_OUTPUT" in *"does not exist"*|*NoSuchBucket*) ;; ` +
      `*) echo "$RB_OUTPUT" >&2; exit 1 ;; esac; fi`,
  ]);
}
