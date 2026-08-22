/**
 * `scripts/poc/seed-graph-load.ts` — M2-2(F-20 本体)の開発・受入・性能計測を兼ねる
 * 使い捨てデータ投入スクリプト(実装計画 `.ai/plans/20260819-m2-knowledge-network/m2-2.md`
 * §設計決定0 参照)。
 *
 * ローカル DB は未削除ノート4件・`note_relations` 0行のままでは `/network` 画面の受入条件の
 * ほとんどが検証できない。パイプライン疎通(worker 起動・ANTHROPIC_API_KEY)を待つと F-20 の
 * 着手そのものがブロックされるため、AI を一切呼ばず `notes`/`note_relations` を直接 INSERT する。
 *
 * 使い方(この環境の pnpm は `--` をそのまま引数として渡してしまうため、`--` は付けない):
 *   pnpm poc:seed-graph --confirm --notes 30 --edges 45
 *   pnpm poc:seed-graph --confirm --notes 300 --edges 900   # 性能計測用
 *   pnpm poc:seed-graph --confirm --cleanup                 # このスクリプトが投入した行だけを削除
 *   pnpm poc:seed-graph --help
 *
 * 引数:
 *   --notes <N>     投入するノート数(既定 30。最小 9 — §規模検証 参照)
 *   --edges <N>     投入するエッジ数(既定 45。最小 7 — 7種類の relation_type を1本ずつ
 *                   割り当てるため。上限は「接続対象ノート数」から決まる組み合わせ数)
 *   --user-id <id>  投入先ユーザー ID(省略時は `users` テーブルの唯一の行を自動選択。
 *                   0件/複数件のときは明示指定を要求してエラー終了する)
 *   --cleanup       投入 (`--notes`/`--edges` は無視)ではなく削除を行う(§安全装置 参照)
 *   --confirm       実際に DB へ書き込む/削除するための明示フラグ(§安全装置 参照。
 *                   これが無いと解決済みの接続先を表示するだけで何もせず終了する)
 *   --help          この使い方を表示して終了する
 *
 * **決定的であること**: 乱数はすべて固定シードの PRNG(mulberry32)から生成し、ノート/エッジの
 * ID もインデックスから決定的に導出する(`node:crypto.randomUUID()` は使わない)。同じ引数で
 * 再実行すると同じ内容になり、`ON DUPLICATE KEY UPDATE` で idempotent に上書きされる。
 *
 * **規模へ収束すること**(Codex レビュー D0 指摘1対応): `--notes`/`--edges` で指定した数は
 * 「今回作る行数」ではなく「投入後にちょうどその件数になる」ことを意味する。前回より小さい
 * 規模で再実行すると、前回生成されて今回の集合に含まれなくなったノート・エッジ(対象ユーザーの
 * シード専用行のみ)を明示的に削除する(`syncToGeneratedSet`)。ノート集合が変わらず `--edges`
 * だけ変えた場合でも、エッジ集合は独立に同期する(ノート削除の CASCADE だけには頼らない)。
 *
 * **ID はユーザーごとに名前空間化されていること**(Codex レビュー D0 指摘2対応): ID には
 * `--user-id`(のハッシュ8桁)を組み込み、ユーザーをまたいだ主キー衝突が起きないようにする
 * (§ID・fingerprint の決定的生成 参照)。既存の同一 ID 行が対象ユーザー以外の所有だった場合は
 * 黙って upsert で上書きせず、書き込み前に処理全体を中止する(`assertNoForeignOwnership`)。
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { and, asc, eq, inArray, like, ne, notInArray, sql } from "drizzle-orm";
import { users } from "../../packages/db/src/schema/users.js";
import {
  notes,
  noteTypeValues,
  type NewNote,
  type NoteType,
} from "../../packages/db/src/schema/notes.js";
import {
  // 7値固定語彙・向きの3値は M1-4b で確定した「生成側(F-19)」の DB 制約そのもの
  // (worker の relation-judge クライアントの応答境界検証がこの語彙へ丸め込む対象)。
  // シード側で値を頭から書き写さず、この import 経由で常に一致させる
  // (計画書 §設計決定0「次善の規律」)。
  noteRelations,
  noteRelationTypeDirectionValues,
  noteRelationTypeValues,
  type NewNoteRelation,
  type NoteRelationType,
  type NoteRelationTypeDirection,
} from "../../packages/db/src/schema/note-relations.js";

/** `MANDATORY_EDGE_SPECS`(下記)がハードコードする `typeDirection` が、import した
 * `noteRelationTypeDirectionValues`(DB 側の語彙)から逸脱していないことを起動時に検証する
 * (§設計決定0「次善の規律」— import した定数を実際に使って値を検証する)。 */
function assertValidDirection(value: string): asserts value is NoteRelationTypeDirection {
  if (!(noteRelationTypeDirectionValues as readonly string[]).includes(value)) {
    throw new Error(`invalid type_direction: ${value}`);
  }
}

// ---------------------------------------------------------------------------
// 安全装置(§安全装置。必須)
// ---------------------------------------------------------------------------

/**
 * 接続先ホストは `scripts/poc/mariadb-vector-poc.ts` と同じく "localhost" に固定し、
 * 環境変数からは一切読まない(本番向けの遠隔ホストへは構造的に到達できない設計。第一の
 * 安全装置)。第二の安全装置として `--confirm` フラグを必須にし、フラグ無しでは解決済みの
 * 接続先を表示するだけで何も書き込まずに終了する。第三に `NODE_ENV=production` を明示的に
 * 拒否する(誤ってこの値を持つシェルで実行された場合の保険)。
 */
const CONNECTION_HOST = "localhost";

interface ResolvedTarget {
  host: string;
  port: number;
  user: string;
  database: string;
}

function resolveConnectionTarget(): ResolvedTarget {
  return {
    host: CONNECTION_HOST,
    port: Number(process.env.MARIADB_PORT ?? 3306),
    user: process.env.MARIADB_USER ?? "secondbrain",
    database: process.env.MARIADB_DATABASE ?? "secondbrain",
  };
}

function assertNotProductionEnv(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "safety guard: refusing to run seed-graph-load with NODE_ENV=production. " +
        "This script writes throwaway fixture data and must never target a production database.",
    );
  }
}

function assertConfirmed(confirm: boolean, target: ResolvedTarget): void {
  if (confirm) {
    return;
  }
  console.error(
    [
      "safety guard: pass --confirm to actually run this script (誤投入防止のガード)。",
      `resolved connection target: ${target.user}@${target.host}:${target.port}/${target.database}`,
      "この確認なしでは DB への書き込み・削除は一切行いません。",
      "--help で使い方を表示できます。",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI 引数
// ---------------------------------------------------------------------------

interface CliArgs {
  notes: number;
  edges: number;
  userId: string | null;
  cleanup: boolean;
  confirm: boolean;
  help: boolean;
}

const DEFAULT_NOTES = 30;
const DEFAULT_EDGES = 45;
const MIN_NOTES = 9; // 接続対象7件(7種類の relation_type 分)+ 孤立2件以上を確保できる最小値
const MIN_EDGES = 7; // 7種類の relation_type を最低1本ずつ割り当てるため

function printUsage(): void {
  console.log(
    [
      // この環境の pnpm は `--` をそのまま引数として渡してしまう(pnpm poc:seed-graph -- --help は
      // 動かない)ため、Usage には `--` を付けない実際に動くコマンド列を書く。
      "Usage: pnpm poc:seed-graph --confirm [--notes <N>] [--edges <N>] [--user-id <uuid>]",
      "       pnpm poc:seed-graph --confirm --cleanup [--user-id <uuid>]",
      "",
      `  --notes <N>    投入するノート数(既定 ${DEFAULT_NOTES}、最小 ${MIN_NOTES})`,
      `  --edges <N>    投入するエッジ数(既定 ${DEFAULT_EDGES}、最小 ${MIN_EDGES})`,
      "  --user-id <id> 投入/削除対象ユーザー ID(省略時は users テーブルの唯一の行を自動選択)",
      "  --cleanup      このスクリプトが投入した行のみを削除する(実データは対象外)",
      "  --confirm      実際に書き込む/削除するための明示フラグ(必須)",
      "  --help         この使い方を表示する",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    notes: DEFAULT_NOTES,
    edges: DEFAULT_EDGES,
    userId: null,
    cleanup: false,
    confirm: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--notes": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value)) {
          throw new Error(`--notes must be an integer, got: ${argv[i]}`);
        }
        args.notes = value;
        break;
      }
      case "--edges": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value)) {
          throw new Error(`--edges must be an integer, got: ${argv[i]}`);
        }
        args.edges = value;
        break;
      }
      case "--user-id":
        args.userId = argv[++i] ?? null;
        break;
      case "--cleanup":
        args.cleanup = true;
        break;
      case "--confirm":
        args.confirm = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg} (--help で使い方を表示できます)`);
    }
  }

  if (!args.cleanup) {
    if (args.notes < MIN_NOTES) {
      throw new Error(`--notes must be >= ${MIN_NOTES} (got: ${args.notes})`);
    }
    if (args.edges < MIN_EDGES) {
      throw new Error(`--edges must be >= ${MIN_EDGES} (got: ${args.edges})`);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// 決定的乱数(mulberry32)・固定シード
// ---------------------------------------------------------------------------

/** 固定シード。**変更しないこと** — 変更すると既存の投入データとの再現性が失われる。 */
const RNG_SEED = 0x53454544; // "SEED" の ASCII を16進数化しただけの、意味を持たない固定値

function mulberry32(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// ID・fingerprint の決定的生成
// ---------------------------------------------------------------------------

/**
 * ID のユーザー名前空間(Codex レビュー D0 指摘2対応)。
 *
 * `noteId`/edge ID はユーザー ID を含まないグローバルな固定値だったため、`--user-id` を
 * 切り替えて再投入すると主キーが衝突し、upsert の `ON DUPLICATE KEY UPDATE` は `user_id` を
 * 更新しないため既存ノートが元ユーザーに残ったまま新ユーザーの内容で上書きされる、という
 * テナント越境の不整合が起きていた。対象ユーザー ID の SHA-256 hex の先頭8桁を ID に
 * 組み込むことで、ユーザーごとに衝突しない決定的な名前空間にする(同じ user-id なら常に
 * 同じ8桁 — §決定的であること を維持)。8桁 hex の衝突確率は 1/16^8 ≈ 1/43億であり、この
 * スクリプトが想定する開発環境のユーザー数(数人〜数十人)に対して実用上無視できる。
 */
function userNamespace(userId: string): string {
  return createHash("sha256")
    .update(`seed-graph-load:user-namespace:${userId}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * 生成したノート ID の一意な名前空間接頭辞(ユーザーごとに異なる)。実 UUID(`randomUUID()`)は
 * 16進数字とハイフンのみで構成される(`g`/`s`/`l` 等の16進数字以外の英字を含まない)ため、
 * `gseed-` を含むこの接頭辞は実データの ID と**構造的に絶対衝突しない**(ユーザー名前空間部分は
 * hex 文字のみだが、先頭の `gseed-` が非16進数字の `g`/`s`/`e`/`d` を含むため全体としての
 * 非衝突性は変わらない)。`--cleanup` はこの接頭辞 + 対象ユーザーIDの組み合わせで削除範囲を
 * 限定する(`packages/db/src/testing/reset-mariadb-database.ts` の `TEST_DATABASE_NAME_PREFIX`
 * と同じ考え方 — 自由文字列の部分一致ではなく、実データが絶対に取り得ない名前空間で範囲を切る)。
 * ID がユーザー名前空間を含むようになったことで、この接頭辞自体がすでにユーザー単位で
 * 分離されており、`user_id` での絞り込みと合わせた二重の安全装置になっている。
 *
 * 長さ確認(`notes.id` は `varchar(36)`): `gseed-` (6) + namespace (8) + `-note-` (6) +
 * 6桁インデックス = 26文字。36文字の上限に十分収まる。
 */
function notePrefixForUser(userId: string): string {
  return `gseed-${userNamespace(userId)}-note-`;
}

function noteId(index: number, userId: string): string {
  return `${notePrefixForUser(userId)}${String(index).padStart(6, "0")}`;
}

/**
 * エッジ ID の名前空間接頭辞。`note_relations.id` も `varchar(36)`。
 * 長さ確認: `gseed-` (6) + namespace (8) + `-edge-` (6) + 6桁 + `-` (1) + 6桁 = 33文字。
 * 36文字の上限に収まる。
 */
function edgePrefixForUser(userId: string): string {
  return `gseed-${userNamespace(userId)}-edge-`;
}

function edgeId(loIndex: number, hiIndex: number, userId: string): string {
  return `${edgePrefixForUser(userId)}${String(loIndex).padStart(6, "0")}-${String(hiIndex).padStart(6, "0")}`;
}

/** SHA-256 hex(64文字)。`notes.embedding_fingerprint`(varchar(64))と同じ形。 */
function fingerprintFor(noteIdValue: string): string {
  return createHash("sha256").update(`seed-graph-load:${noteIdValue}`).digest("hex");
}

// ---------------------------------------------------------------------------
// note_relations の境界値(次善の規律: worker の書き込み経路から導出する)
// ---------------------------------------------------------------------------

/**
 * `note_relations.description` の上限(§設計決定0「次善の規律」)。
 *
 * この定数は2箇所から導出する:
 * - `packages/db/src/schema/note-relations.ts` の
 *   `description: varchar("description", { length: 500 })`(DB 制約そのもの。import 可能な
 *   エクスポートが無いためこのファイルではリテラル 500 として再掲する)
 * - `apps/worker/src/queues/note-enrichment/relation-judge.client.ts` の
 *   `RELATION_DESCRIPTION_MAX_LENGTH`(同じ 500。ただし `export` されていない private 定数の
 *   ため import 不可 — このコメントが参照元の明記に当たる)
 */
const DESCRIPTION_MAX_LENGTH = 500;

/**
 * `relatedness` の正規化規則(§設計決定0「次善の規律」)。DB 列は `decimal(3,2)`
 * (`note-relations.ts`)。実際の clamp・丸め処理は
 * `relation-judge.client.ts` の `normalizeRelatedness`(非 export の private 関数につき
 * import 不可 — 0〜1 に clamp して小数第2位に丸める、という規則をここに複製する)。
 * シードでは値そのものを計算時点で 0.00〜1.00 の範囲で生成するため、このヘルパーは
 * 二重防御の丸めのみ行う。
 */
function relatednessString(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped.toFixed(2);
}

// ---------------------------------------------------------------------------
// コンテンツ生成
// ---------------------------------------------------------------------------

const TOPIC_WORDS = [
  "機械学習",
  "ネットワーク設計",
  "読書メモ",
  "旅行記録",
  "料理レシピ",
  "プロジェクト管理",
  "英語学習",
  "健康管理",
  "家計簿",
  "プログラミング",
  "デザイン",
  "マーケティング",
  "心理学",
  "歴史",
  "天文学",
  "法律",
  "建築",
  "音楽理論",
  "写真",
  "ガーデニング",
] as const;

/** relation_type ごとの説明テンプレート(7値の網羅を型で強制する)。 */
const DESCRIPTION_TEMPLATES: Record<NoteRelationType, string> = {
  "same-theme": "同じテーマ・話題を扱っているため関連付けた。",
  "cause-solution": "一方が問題の原因を、もう一方がその解決策を説明しているため関連付けた。",
  "claim-counter": "一方の主張に対してもう一方が反論する内容のため関連付けた。",
  "concept-hierarchy": "概念の上位/下位(親子)関係にあるため関連付けた。",
  "tech-example": "技術とその具体的な活用例の関係にあるため関連付けた。",
  "problem-remedy": "問題とその対処法の関係にあるため関連付けた。",
  other: "上記のいずれにも当てはまらないが、内容の関連性が認められたため関連付けた。",
} satisfies Record<NoteRelationType, string>;

/** ノート生成のベース時刻(固定。決定的な `created_at`/`updated_at` にするため)。 */
const BASE_TIMESTAMP_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * `NewNote`(`packages/db/src/schema/notes.ts` の `$inferInsert`)から必要な列だけを
 * `Pick` した型。列を1つ1つ手で再宣言せず、スキーマ側の型定義に直結させることで
 * ドリフト(列名変更・型変更の見落とし)を構造的に防ぐ(`embedding` 列は §基本の要件どおり
 * 意図的に含めない)。
 */
type NoteSeedRow = Pick<
  NewNote,
  | "id"
  | "userId"
  | "type"
  | "title"
  | "body"
  | "summary"
  | "tags"
  | "status"
  | "failureReason"
  | "imageKey"
  | "imageMimeType"
  | "concepts"
  | "extractedText"
  | "processingGeneration"
  | "processingAttemptToken"
  | "embeddingModel"
  | "embeddingFingerprint"
  | "enrichmentStatus"
  | "relationStatus"
  | "relationFingerprint"
  | "createdAt"
  | "updatedAt"
>;

/**
 * 敵対的な値のための予約インデックス(§敵対的な値を必ず混ぜる)。connectedCount(後述)は
 * 最低 7 を保証するため、これらのインデックスは常に「接続対象プール」の中に収まる。
 */
const TITLE_NULL_NOTE_INDEX = 0;
const SCREENSHOT_BODY_NULL_NOTE_INDEX = 1;

function generateNote(index: number, userId: string): NoteSeedRow {
  const topic = TOPIC_WORDS[index % TOPIC_WORDS.length];
  let type: NoteType = noteTypeValues[index % noteTypeValues.length];
  let title: string | null = `${topic}に関するメモ #${index}`;
  let body: string | null = `${topic}についての記録。詳細は本文に記載する(seed index ${index})。`;
  let extractedText: string | null = null;

  // 敵対的な値: スクショノートで body=NULL(bodyPreview が NULL になる経路)。
  // 実システムの不変条件でもある(notes.ts のコメント参照: screenshot ノートはユーザー入力
  // 本文が存在しないため body: null で作成する)。この専用インデックスに加え、下の
  // type === "screenshot" 分岐により i % 3 サイクルで選ばれる他のノートも同じ扱いになる。
  if (index === SCREENSHOT_BODY_NULL_NOTE_INDEX) {
    type = "screenshot";
  }
  if (type === "screenshot") {
    body = null;
    extractedText = `${topic}のスクリーンショットから抽出したテキスト(seed index ${index})。`;
  }

  // 敵対的な値: title=NULL のノート。
  if (index === TITLE_NULL_NOTE_INDEX) {
    title = null;
  }

  const id = noteId(index, userId);
  const fingerprint = fingerprintFor(id);

  return {
    id,
    userId,
    type,
    title,
    body,
    summary: `${topic}の要約(seed index ${index})。`,
    tags: [topic],
    status: "completed",
    failureReason: null,
    imageKey: null,
    imageMimeType: null,
    concepts: [topic],
    extractedText,
    processingGeneration: 0,
    processingAttemptToken: null,
    embeddingModel: "text-embedding-3-small",
    embeddingFingerprint: fingerprint,
    enrichmentStatus: "completed",
    relationStatus: "completed",
    // 必須要件(§基本): relation_fingerprint = embedding_fingerprint(終端状態)。
    relationFingerprint: fingerprint,
    createdAt: new Date(BASE_TIMESTAMP_MS + index * 60_000),
    updatedAt: new Date(BASE_TIMESTAMP_MS + index * 60_000),
  };
}

/** `NewNoteRelation`(`note-relations.ts` の `$inferInsert`)からの `Pick`(NoteSeedRow と同じ理由)。 */
type EdgeSeedRow = Pick<
  NewNoteRelation,
  | "id"
  | "userId"
  | "noteAId"
  | "noteBId"
  | "sourceNoteId"
  | "relationType"
  | "typeDirection"
  | "description"
  | "relatedness"
  | "noteAFingerprint"
  | "noteBFingerprint"
  | "createdAt"
  | "updatedAt"
>;

/** `(min(i,j), max(i,j))` の pair キー(index ベース。ID は index に対し単調増加なので、
 * このまま note_a_id < note_b_id の正規化と一致する)。 */
function pairKey(i: number, j: number): string {
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return `${lo}-${hi}`;
}

function directionForType(type: NoteRelationType, prng: () => number): NoteRelationTypeDirection {
  // same-theme/other は常に none(M1-4b §設計決定1。noteRelationTypeDirectionValues の
  // 語彙そのものは import 済みだが、この業務規則は relation-judge.client.ts の
  // normalizeResultItem に相当する箇所でありシード側でも同じ規則を適用する)。
  if (type === "same-theme" || type === "other") {
    return "none";
  }
  return prng() < 0.5 ? "a-to-b" : "b-to-a";
}

interface MandatoryEdgeSpec {
  aIndex: number;
  bIndex: number;
  relationType: NoteRelationType;
  typeDirection: NoteRelationTypeDirection;
  relatedness: string;
  description: string;
}

/**
 * 7種類の relation_type を1本ずつ確実に割り当てる固定エッジ(§データの多様性)。
 * 同時に敵対的な値(§敵対的な値を必ず混ぜる)も一緒に満たす:
 * - concept-hierarchy: relatedness = "1.00"(境界値・上限)
 * - tech-example: relatedness = "0.00"(境界値・下限)
 * - problem-remedy: description がちょうど500文字(マルチバイト)
 * - other: type_direction = "none"(other は常に none。DB 制約というより業務規則の確認)
 */
const MANDATORY_EDGE_SPECS: MandatoryEdgeSpec[] = [
  {
    aIndex: 0,
    bIndex: 1,
    relationType: "same-theme",
    typeDirection: "none",
    relatedness: "0.50",
    description: DESCRIPTION_TEMPLATES["same-theme"],
  },
  {
    aIndex: 1,
    bIndex: 2,
    relationType: "cause-solution",
    typeDirection: "a-to-b",
    relatedness: "0.65",
    description: DESCRIPTION_TEMPLATES["cause-solution"],
  },
  {
    aIndex: 2,
    bIndex: 3,
    relationType: "claim-counter",
    typeDirection: "b-to-a",
    relatedness: "0.30",
    description: DESCRIPTION_TEMPLATES["claim-counter"],
  },
  {
    aIndex: 3,
    bIndex: 4,
    relationType: "concept-hierarchy",
    typeDirection: "a-to-b",
    relatedness: "1.00",
    description: DESCRIPTION_TEMPLATES["concept-hierarchy"],
  },
  {
    aIndex: 4,
    bIndex: 5,
    relationType: "tech-example",
    typeDirection: "b-to-a",
    relatedness: "0.00",
    description: DESCRIPTION_TEMPLATES["tech-example"],
  },
  {
    aIndex: 5,
    bIndex: 6,
    relationType: "problem-remedy",
    typeDirection: "a-to-b",
    relatedness: "0.55",
    // 敵対的な値: description ちょうど500文字(マルチバイト)。
    description: "あ".repeat(DESCRIPTION_MAX_LENGTH),
  },
  {
    aIndex: 0,
    bIndex: 6,
    relationType: "other",
    typeDirection: "none",
    relatedness: "0.20",
    description: DESCRIPTION_TEMPLATES["other"],
  },
];

function buildEdgeRow(
  userId: string,
  aIndex: number,
  bIndex: number,
  relationType: NoteRelationType,
  typeDirection: NoteRelationTypeDirection,
  relatedness: string,
  description: string,
  createdAt: Date,
): EdgeSeedRow {
  assertValidDirection(typeDirection);
  const lo = Math.min(aIndex, bIndex);
  const hi = Math.max(aIndex, bIndex);
  const noteAId = noteId(lo, userId);
  const noteBId = noteId(hi, userId);
  return {
    // ノート同様、決定的な ID にする(乱数 randomUUID は使わない。§決定的であること)。
    id: edgeId(lo, hi, userId),
    userId,
    noteAId,
    noteBId,
    // source_note_id は note_a_id/note_b_id いずれかであればよい(DB CHECK 制約)。
    // シードには「保存の起点」という実際の意味は無いため note_a_id 側に固定する。
    sourceNoteId: noteAId,
    relationType,
    typeDirection,
    description: description.slice(0, DESCRIPTION_MAX_LENGTH),
    relatedness: relatednessString(Number(relatedness)),
    noteAFingerprint: fingerprintFor(noteAId),
    noteBFingerprint: fingerprintFor(noteBId),
    createdAt,
    updatedAt: createdAt,
  };
}

function generateEdges(
  notesCount: number,
  edgesCount: number,
  userId: string,
  prng: () => number,
): { edges: EdgeSeedRow[]; connectedCount: number; isolatedCount: number } {
  // 孤立ノードを必ず混ぜる(§データの多様性)。既定は約15%だが、最低2件・最低7件の
  // 接続対象(7種類の relation_type 分)を必ず確保する。
  let isolatedCount = Math.max(2, Math.round(notesCount * 0.15));
  let connectedCount = notesCount - isolatedCount;
  if (connectedCount < 7) {
    connectedCount = 7;
    isolatedCount = notesCount - connectedCount;
  }
  if (isolatedCount < 0) {
    // parseArgs の MIN_NOTES チェックで通常ここには来ないが、念のため防御する。
    throw new Error(
      `--notes is too small to fit 7 connectable notes + at least 0 isolated notes (got: ${notesCount})`,
    );
  }

  const connectedIndices = Array.from({ length: connectedCount }, (_, i) => i);
  const maxPossiblePairs = (connectedCount * (connectedCount - 1)) / 2;
  if (edgesCount > maxPossiblePairs) {
    throw new Error(
      `--edges (${edgesCount}) exceeds the maximum distinct pairs among connectable notes ` +
        `(${maxPossiblePairs} for ${connectedCount} connectable notes out of --notes ${notesCount}). ` +
        "Increase --notes or decrease --edges.",
    );
  }

  const usedPairs = new Set<string>();
  const edges: EdgeSeedRow[] = [];
  const createdAt = new Date(BASE_TIMESTAMP_MS);

  for (const spec of MANDATORY_EDGE_SPECS) {
    edges.push(
      buildEdgeRow(
        userId,
        spec.aIndex,
        spec.bIndex,
        spec.relationType,
        spec.typeDirection,
        spec.relatedness,
        spec.description,
        createdAt,
      ),
    );
    usedPairs.add(pairKey(spec.aIndex, spec.bIndex));
  }

  const maxAttempts = Math.max(1000, edgesCount * 50);
  let attempts = 0;
  while (edges.length < edgesCount) {
    attempts++;
    if (attempts > maxAttempts) {
      throw new Error(
        "failed to generate enough unique edges within the attempt budget " +
          "(this should not happen given the maxPossiblePairs check above; please report)",
      );
    }
    const i = connectedIndices[Math.floor(prng() * connectedIndices.length)];
    let j = connectedIndices[Math.floor(prng() * connectedIndices.length)];
    while (j === i) {
      j = connectedIndices[Math.floor(prng() * connectedIndices.length)];
    }
    const key = pairKey(i, j);
    if (usedPairs.has(key)) {
      continue;
    }
    usedPairs.add(key);

    const relationType = noteRelationTypeValues[Math.floor(prng() * noteRelationTypeValues.length)];
    const typeDirection = directionForType(relationType, prng);
    const relatedness = 0.05 + prng() * 0.9; // 0.05〜0.95(境界値は MANDATORY_EDGE_SPECS 側で確保済み)
    const description = `${DESCRIPTION_TEMPLATES[relationType]}(seed pair ${pairKey(i, j)})`;

    edges.push(
      buildEdgeRow(
        userId,
        i,
        j,
        relationType,
        typeDirection,
        relatedness.toFixed(2),
        description,
        createdAt,
      ),
    );
  }

  return { edges, connectedCount, isolatedCount };
}

// ---------------------------------------------------------------------------
// DB 書き込み
// ---------------------------------------------------------------------------

type Db = MySql2Database;

function noteUpsertSql(note: NoteSeedRow) {
  return sql`
    INSERT INTO notes (
      id, user_id, type, title, body, summary, tags, status, failure_reason,
      image_key, image_mime_type, concepts, extracted_text, deleted_at,
      processing_generation, processing_attempt_token, embedding_model,
      embedding_fingerprint, enrichment_status, relation_status, relation_fingerprint,
      created_at, updated_at
    ) VALUES (
      ${note.id}, ${note.userId}, ${note.type}, ${note.title}, ${note.body}, ${note.summary},
      ${JSON.stringify(note.tags)}, ${note.status}, ${note.failureReason},
      ${note.imageKey}, ${note.imageMimeType}, ${JSON.stringify(note.concepts)}, ${note.extractedText},
      NULL,
      ${note.processingGeneration}, ${note.processingAttemptToken}, ${note.embeddingModel},
      ${note.embeddingFingerprint}, ${note.enrichmentStatus}, ${note.relationStatus},
      ${note.relationFingerprint}, ${note.createdAt}, ${note.updatedAt}
    )
    ON DUPLICATE KEY UPDATE
      type = VALUES(type), title = VALUES(title), body = VALUES(body), summary = VALUES(summary),
      tags = VALUES(tags), status = VALUES(status), failure_reason = VALUES(failure_reason),
      image_key = VALUES(image_key), image_mime_type = VALUES(image_mime_type),
      concepts = VALUES(concepts), extracted_text = VALUES(extracted_text), deleted_at = VALUES(deleted_at),
      processing_generation = VALUES(processing_generation),
      processing_attempt_token = VALUES(processing_attempt_token),
      embedding_model = VALUES(embedding_model), embedding_fingerprint = VALUES(embedding_fingerprint),
      enrichment_status = VALUES(enrichment_status), relation_status = VALUES(relation_status),
      relation_fingerprint = VALUES(relation_fingerprint), updated_at = VALUES(updated_at)
  `;
}

function edgeUpsertSql(edge: EdgeSeedRow) {
  return sql`
    INSERT INTO note_relations (
      id, user_id, note_a_id, note_b_id, source_note_id,
      relation_type, type_direction, description, relatedness,
      note_a_fingerprint, note_b_fingerprint, created_at, updated_at
    ) VALUES (
      ${edge.id}, ${edge.userId}, ${edge.noteAId}, ${edge.noteBId}, ${edge.sourceNoteId},
      ${edge.relationType}, ${edge.typeDirection}, ${edge.description}, ${edge.relatedness},
      ${edge.noteAFingerprint}, ${edge.noteBFingerprint}, ${edge.createdAt}, ${edge.updatedAt}
    )
    ON DUPLICATE KEY UPDATE
      source_note_id = VALUES(source_note_id), relation_type = VALUES(relation_type),
      type_direction = VALUES(type_direction), description = VALUES(description),
      relatedness = VALUES(relatedness), note_a_fingerprint = VALUES(note_a_fingerprint),
      note_b_fingerprint = VALUES(note_b_fingerprint), updated_at = VALUES(updated_at)
  `;
}

async function resolveUserId(db: Db, explicitUserId: string | null): Promise<string> {
  if (explicitUserId) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, explicitUserId))
      .limit(1);
    if (rows.length === 0) {
      throw new Error(`--user-id ${explicitUserId} was not found in the users table`);
    }
    return rows[0].id;
  }

  const all = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt));
  if (all.length === 0) {
    throw new Error(
      "no rows in users table. Create a user first (e.g. `pnpm db:seed`) or pass --user-id explicitly.",
    );
  }
  if (all.length > 1) {
    throw new Error(
      `users table has ${all.length} rows; pass --user-id <uuid> explicitly to disambiguate ` +
        `(candidates: ${all.map((u) => u.id).join(", ")})`,
    );
  }
  return all[0].id;
}

/**
 * 書き込み前の所有者検証(Codex レビュー D0 指摘2対応)。
 *
 * 今回生成した ID の中に、既に対象ユーザー以外が所有する行(`notes.user_id`/
 * `note_relations.user_id` が一致しない行)が存在する場合は、upsert で黙って上書きせず、
 * 何も書き込まずに処理全体を中止する。ID はユーザーごとに名前空間化済み(`userNamespace`)
 * のため通常はここで検出されることはないはずだが、ハッシュ衝突や過去に別の仕組みで投入された
 * 行が万一残っていた場合の最後の防御線として置く。
 */
async function assertNoForeignOwnership(
  db: Db,
  userId: string,
  noteRows: NoteSeedRow[],
  edges: EdgeSeedRow[],
): Promise<void> {
  const noteIds = noteRows.map((note) => note.id);
  const conflictingNotes = await db
    .select({ id: notes.id, userId: notes.userId })
    .from(notes)
    .where(and(inArray(notes.id, noteIds), ne(notes.userId, userId)));
  if (conflictingNotes.length > 0) {
    const sample = conflictingNotes[0];
    throw new Error(
      `owner check failed: ${conflictingNotes.length} note id(s) generated for user ${userId} ` +
        `already exist under a different owner (e.g. ${sample.id} belongs to ${sample.userId}). ` +
        "Aborting before writing anything — this must not silently overwrite another user's data.",
    );
  }

  const edgeIds = edges.map((edge) => edge.id);
  const conflictingEdges = await db
    .select({ id: noteRelations.id, userId: noteRelations.userId })
    .from(noteRelations)
    .where(and(inArray(noteRelations.id, edgeIds), ne(noteRelations.userId, userId)));
  if (conflictingEdges.length > 0) {
    const sample = conflictingEdges[0];
    throw new Error(
      `owner check failed: ${conflictingEdges.length} note_relations id(s) generated for user ` +
        `${userId} already exist under a different owner (e.g. ${sample.id} belongs to ` +
        `${sample.userId}). Aborting before writing anything.`,
    );
  }
}

/**
 * 規模への収束(Codex レビュー D0 指摘1対応)。
 *
 * 今回生成した ID 集合(`noteRows`/`edges`)に含まれない、対象ユーザーのシード専用行
 * (接頭辞 + user_id で絞り込み。`--cleanup` と同じ安全性)を削除する。エッジを先に、
 * ノートを後に削除する: ノート集合が変わらず `--edges` だけ変えた再実行では、ノート削除の
 * `ON DELETE CASCADE` が一切発生しないため、CASCADE だけに頼るとエッジ集合が収束しない
 * (指摘1後半で明示された論点)。エッジを独立に同期しておけば、後続のノート削除がどちらの
 * 順でも同じ結果になる。
 */
async function syncToGeneratedSet(
  db: Db,
  userId: string,
  noteRows: NoteSeedRow[],
  edges: EdgeSeedRow[],
): Promise<{ deletedEdges: number; deletedNotes: number }> {
  const currentEdgeIds = edges.map((edge) => edge.id);
  const currentNoteIds = noteRows.map((note) => note.id);

  const edgeDeleteResult = await db
    .delete(noteRelations)
    .where(
      and(
        eq(noteRelations.userId, userId),
        like(noteRelations.id, `${edgePrefixForUser(userId)}%`),
        notInArray(noteRelations.id, currentEdgeIds),
      ),
    );
  const deletedEdges = (edgeDeleteResult[0] as unknown as { affectedRows: number }).affectedRows;

  const noteDeleteResult = await db
    .delete(notes)
    .where(
      and(
        eq(notes.userId, userId),
        like(notes.id, `${notePrefixForUser(userId)}%`),
        notInArray(notes.id, currentNoteIds),
      ),
    );
  const deletedNotes = (noteDeleteResult[0] as unknown as { affectedRows: number }).affectedRows;

  return { deletedEdges, deletedNotes };
}

/**
 * 実際に次数0(=関係が0本)になったノート数を、生成したエッジ集合から数え直す。
 *
 * `generateEdges` の `isolatedCount`(孤立用に**予約した**件数)とは一致しないことがある。
 * 予約はあくまで「接続対象プールから除外した件数」であり、プールに残ったノードへエッジを
 * ランダムに割り当てる過程で、プール内のノードにも偶然1本もエッジが付かないことがあるため
 * (`--edges` がプールの組み合わせ数に対して少ないほど起きやすい)。**これはバグではなく
 * 意図された挙動**であり、受入条件6(「表示 N / 全 M ノート」)の期待値は「予約件数」ではなく
 * この関数が返す実測値で確認すること。
 */
function countActualDegreeZero(noteRows: NoteSeedRow[], edges: EdgeSeedRow[]): number {
  const connectedNoteIds = new Set<string>();
  for (const edge of edges) {
    connectedNoteIds.add(edge.noteAId);
    connectedNoteIds.add(edge.noteBId);
  }
  return noteRows.filter((note) => !connectedNoteIds.has(note.id)).length;
}

async function runSeed(db: Db, args: CliArgs, userId: string): Promise<void> {
  const prng = mulberry32(RNG_SEED);

  const noteRows: NoteSeedRow[] = Array.from({ length: args.notes }, (_, i) =>
    generateNote(i, userId),
  );
  const { edges, connectedCount, isolatedCount } = generateEdges(
    args.notes,
    args.edges,
    userId,
    prng,
  );

  // 指摘2 対応: 書き込み前に所有者検証を行う。同じ ID の既存行が対象ユーザー以外の所有なら、
  // upsert で黙って上書きせず処理全体を中止する。
  await assertNoForeignOwnership(db, userId, noteRows, edges);

  console.log(`inserting ${noteRows.length} notes...`);
  for (let i = 0; i < noteRows.length; i++) {
    await db.execute(noteUpsertSql(noteRows[i]));
    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${noteRows.length} notes done`);
    }
  }

  console.log(`inserting ${edges.length} edges...`);
  for (let i = 0; i < edges.length; i++) {
    await db.execute(edgeUpsertSql(edges[i]));
    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${edges.length} edges done`);
    }
  }

  // 指摘1 対応: 今回生成した ID 集合に収束させる(前回より小さい規模で再実行した場合の
  // 旧ノート・旧エッジの残存を防ぐ。§規模へ収束すること 参照)。
  console.log("syncing to this run's scale (removing stale seed rows not in this generation)...");
  const { deletedEdges, deletedNotes } = await syncToGeneratedSet(db, userId, noteRows, edges);

  // ---- 生成データの構成レポート ----
  const typeCounts = new Map<NoteType, number>();
  for (const note of noteRows) {
    typeCounts.set(note.type, (typeCounts.get(note.type) ?? 0) + 1);
  }
  const relationTypeCounts = new Map<NoteRelationType, number>();
  const directionCounts = new Map<NoteRelationTypeDirection, number>();
  for (const edge of edges) {
    relationTypeCounts.set(edge.relationType, (relationTypeCounts.get(edge.relationType) ?? 0) + 1);
    directionCounts.set(edge.typeDirection, (directionCounts.get(edge.typeDirection) ?? 0) + 1);
  }

  console.log("");
  console.log("=== seed-graph-load summary ===");
  console.log(`userId: ${userId}`);
  const actualDegreeZeroCount = countActualDegreeZero(noteRows, edges);
  console.log(
    `notes: ${noteRows.length} (connected pool: ${connectedCount}, designated isolated: ${isolatedCount}, actual degree-0: ${actualDegreeZeroCount})`,
  );
  console.log(`  by type: ${JSON.stringify(Object.fromEntries(typeCounts))}`);
  console.log(`edges: ${edges.length}`);
  console.log(`  by relation_type: ${JSON.stringify(Object.fromEntries(relationTypeCounts))}`);
  console.log(`  by type_direction: ${JSON.stringify(Object.fromEntries(directionCounts))}`);
  console.log(`title=NULL note: ${noteId(TITLE_NULL_NOTE_INDEX, userId)}`);
  console.log(`screenshot body=NULL note: ${noteId(SCREENSHOT_BODY_NULL_NOTE_INDEX, userId)}`);
  console.log(
    "boundary edges: relatedness=0.00/1.00, description=500文字, relation_type=other(direction=none)",
  );
  // 指摘1 対応: 規模がちょうど --notes/--edges に収束したことを明示する(この行が
  // 受入確認時の「表示 N / 全 M ノート」の根拠になる)。
  console.log(
    `removed stale rows not in this generation: ${deletedEdges} edges, ${deletedNotes} notes — ` +
      `this user's seed data now converges to exactly notes=${noteRows.length}, edges=${edges.length}.`,
  );
  console.log("done.");
}

async function runCleanup(db: Db, userId: string): Promise<void> {
  // §安全装置「--cleanup は曖昧な部分一致で消さない」: notePrefixForUser(userId) は実 UUID とも
  // 他ユーザーのシード行とも構造的に衝突しない名前空間(ユーザーハッシュを含む)であり、
  // かつ user_id でも絞る(二重の境界。指摘2 対応でユーザー名前空間化した後も維持)。
  const result = await db.execute(
    sql`DELETE FROM notes WHERE user_id = ${userId} AND id LIKE ${`${notePrefixForUser(userId)}%`}`,
  );
  const affectedRows = (result[0] as unknown as { affectedRows: number }).affectedRows;
  // note_relations は notes への FK が ON DELETE CASCADE(note-relations.ts 参照)のため、
  // 上の DELETE だけで関連エッジも自動的に削除される(別途 DELETE は不要)。
  console.log(
    `deleted ${affectedRows} notes (and their note_relations rows via ON DELETE CASCADE)`,
  );
}

// ---------------------------------------------------------------------------
// エントリーポイント
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  assertNotProductionEnv();
  const target = resolveConnectionTarget();
  assertConfirmed(args.confirm, target);

  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: process.env.MARIADB_PASSWORD ?? "changeme-app",
    database: target.database,
  });
  const db = drizzle(connection);

  try {
    const userId = await resolveUserId(db, args.userId);
    if (args.cleanup) {
      await runCleanup(db, userId);
    } else {
      await runSeed(db, args, userId);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
