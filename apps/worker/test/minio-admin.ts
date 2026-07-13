import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `apps/worker` の統合テスト用セットアップから、`docker-compose.yml` の `minio-init` サービスと
 * 同じ `minio/mc` イメージを使い捨てコンテナで呼び出すためのヘルパー(§ テスト用 MinIO 資格情報の
 * 方針・「mc 管理コマンドの実行手段」参照)。`apps/api/test/minio-admin.ts` と同一パターン
 * (r4 指摘 [4] を受け cross-app 参照をやめているため、ワークスペースごとに複製する)。
 */

const MC_IMAGE = "minio/mc:RELEASE.2025-08-13T08-35-41Z";
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SCRIPTS_DIR = resolve(REPO_ROOT, "scripts");

// コンテナ内から見た MinIO のエンドポイント(Compose のサービス名解決)。
export const MC_CONTAINER_ENDPOINT = "http://minio:9000";
export const MC_ALIAS = "local";

/** 実装時に確定・§ テスト用 MinIO 資格情報の方針 参照(apps/api 側と同じロジック)。 */
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
      reject(new Error(`docker command exited with code ${code}: ${stderr.slice(0, 2000)}`));
    });
  });
}

/**
 * `scripts/minio-app-policy.sh` / `scripts/minio-app-policy-cleanup.sh` を使い捨てコンテナから
 * 呼び出す。秘密値は `spawn` の `env` 経由・`-e VAR`(値省略形)でコンテナへ渡す。
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

// `MC_HOST_<alias>` 環境変数方式は資格情報のURLエンコードが必要になり、r6([B-1]・[E-2]:
// 未エンコードによる実害)・r7([B-2]:過剰な事前検証による有効な資格情報の拒否)と
// 2ラウンド連続で問題が発生したため `mc alias set` へ差し戻す(Codex コードレビュー r7
// 指摘 [B-2] への対応。apps/api 側と同じロジック)。秘密値は `spawn` の `env` オプション
// 経由で渡し、プロセス引数には含めない(使い捨てコンテナ内でのみ一時的にプロセス引数へ
// 現れる点は既知の残存リスクとして受容)。
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

/** `mc mb --ignore-existing`(root 資格情報)。 */
export async function createBucketIfMissing(bucketName: string): Promise<void> {
  await runRootMcCommands([`mc mb --ignore-existing ${MC_ALIAS}/${bucketName}`]);
}

/**
 * `mc rb --force`(存在しなければ無視。root 資格情報)。以前は `2>/dev/null || true` で
 * 終了コードを問わず常に成功扱いにしており、認証エラー・ネットワーク障害等の「バケット
 * 不在」以外の失敗も握り潰していた(Codex コードレビュー 2026-07-13 r5 指摘 [A-2] への
 * 対応。apps/api 側の同種修正と同一パターン)。`scripts/minio-app-policy-cleanup.sh` の
 * `is_not_found_error()` と同じ判定基準で、バケット不在エラーのみを無視する。
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
