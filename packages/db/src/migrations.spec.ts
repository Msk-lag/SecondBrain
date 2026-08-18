import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * 生成済みマイグレーション SQL の静的検証。
 * users テーブルは M1 全体(認証・user_id データ分離)の土台のため、
 * migration 再生成で重要制約が落ちた場合に CI で検出する。
 */
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function readAllMigrationSql(): string {
  const files = listMigrationFiles();
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => readFileSync(join(migrationsDir, file), "utf8")).join("\n");
}

function readMigrationFile(file: string): string {
  return readFileSync(join(migrationsDir, file), "utf8");
}

/**
 * concepts 列の追加(nullable)を含むマイグレーションファイル名を探す
 * (§ concepts 列の NOT NULL 化(既存行の移行手順) の1段階目)。
 */
function findConceptsAddMigrationFile(): string {
  const files = listMigrationFiles();
  const found = files.find((file) => /ADD `concepts`/i.test(readMigrationFile(file)));
  expect(found).toBeDefined();
  return found as string;
}

/**
 * concepts 列を NOT NULL化する MODIFY COLUMN を含むマイグレーションファイル名を探す
 * (§ concepts 列の NOT NULL 化(既存行の移行手順) の2段階目)。
 */
function findConceptsNotNullMigrationFile(): string {
  const files = listMigrationFiles();
  const found = files.find((file) =>
    /MODIFY COLUMN `concepts` json NOT NULL/i.test(readMigrationFile(file)),
  );
  expect(found).toBeDefined();
  return found as string;
}

describe("users テーブルのマイグレーション SQL", () => {
  const sql = readAllMigrationSql();

  it("users テーブルを作成している", () => {
    expect(sql).toMatch(/CREATE TABLE `users`/i);
  });

  it("id が varchar(36) の主キーである", () => {
    expect(sql).toMatch(/`id` varchar\(36\) NOT NULL/i);
    expect(sql).toMatch(/PRIMARY KEY\(`id`\)/i);
  });

  it("email が NOT NULL かつ UNIQUE である", () => {
    expect(sql).toMatch(/`email` varchar\(255\) NOT NULL/i);
    expect(sql).toMatch(/UNIQUE\(`email`\)/i);
  });

  it("password_hash が NOT NULL である", () => {
    expect(sql).toMatch(/`password_hash` varchar\(255\) NOT NULL/i);
  });

  it("created_at / updated_at がデフォルト付き NOT NULL である", () => {
    expect(sql).toMatch(/`created_at` timestamp NOT NULL DEFAULT/i);
    expect(sql).toMatch(/`updated_at` timestamp NOT NULL DEFAULT/i);
  });
});

describe("notes テーブルのマイグレーション SQL", () => {
  const sql = readAllMigrationSql();

  it("notes テーブルを作成している", () => {
    expect(sql).toMatch(/CREATE TABLE `notes`/i);
  });

  it("id が varchar(36) の主キーである", () => {
    expect(sql).toMatch(/`id` varchar\(36\) NOT NULL/i);
    expect(sql).toMatch(/CONSTRAINT `notes_id` PRIMARY KEY\(`id`\)/i);
  });

  it("user_id が NOT NULL かつ users への外部キーである", () => {
    expect(sql).toMatch(/`user_id` varchar\(36\) NOT NULL/i);
    expect(sql).toMatch(
      /ALTER TABLE `notes` ADD CONSTRAINT `notes_user_id_users_id_fk` FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)/i,
    );
  });

  it("type が memo/url/screenshot の enum で default memo である", () => {
    expect(sql).toMatch(/`type` enum\('memo','url','screenshot'\) NOT NULL DEFAULT 'memo'/i);
  });

  it("title/summary は nullable である", () => {
    expect(sql).toMatch(/`title` varchar\(255\),/i);
    expect(sql).toMatch(/`summary` text,/i);
  });

  it("body は当初 NOT NULL で作成され、0002 で nullable 化される(screenshot ノートは body: null)", () => {
    // 0001(初期作成)時点では NOT NULL
    expect(sql).toMatch(/`body` text NOT NULL/i);
    // 後続マイグレーションで NOT NULL を外す MODIFY COLUMN が存在する
    // (§ notes テーブル拡張・削除の論理削除化 参照。screenshot ノートは body: null で作成する)
    expect(sql).toMatch(/ALTER TABLE `notes` MODIFY COLUMN `body` text;/i);
  });

  it("tags が NOT NULL の json カラムである", () => {
    expect(sql).toMatch(/`tags` json NOT NULL/i);
  });

  it("created_at / updated_at がデフォルト付き NOT NULL である", () => {
    expect(sql).toMatch(/`created_at` timestamp NOT NULL DEFAULT/i);
    expect(sql).toMatch(/`updated_at` timestamp NOT NULL DEFAULT/i);
  });

  it("カーソルページネーション用の複合インデックスを持つ", () => {
    expect(sql).toMatch(
      /CREATE INDEX `notes_user_id_created_at_id_idx` ON `notes` \(`user_id`,`created_at`,`id`\)/i,
    );
  });
});

describe("notes テーブル拡張(M1-3 スクショ AI 解析)のマイグレーション SQL", () => {
  const sql = readAllMigrationSql();

  it("status が pending/processing/completed/failed の enum で default completed である", () => {
    expect(sql).toMatch(
      /ADD `status` enum\('pending','processing','completed','failed'\).*DEFAULT 'completed'.*NOT NULL/i,
    );
  });

  it("failure_reason が nullable な varchar(500) である", () => {
    expect(sql).toMatch(/ADD `failure_reason` varchar\(500\);/i);
  });

  it("image_key が nullable な varchar(512) である", () => {
    expect(sql).toMatch(/ADD `image_key` varchar\(512\);/i);
  });

  it("image_mime_type が nullable な varchar(100) である", () => {
    expect(sql).toMatch(/ADD `image_mime_type` varchar\(100\);/i);
  });

  it("extracted_text が nullable な text である", () => {
    expect(sql).toMatch(/ADD `extracted_text` text;/i);
  });

  it("deleted_at が nullable な timestamp である", () => {
    expect(sql).toMatch(/ADD `deleted_at` timestamp;/i);
  });

  it("processing_generation が NOT NULL の int で default 0 である", () => {
    expect(sql).toMatch(/ADD `processing_generation` int.*DEFAULT 0.*NOT NULL/i);
  });

  it("processing_attempt_token が nullable な varchar(36) である", () => {
    expect(sql).toMatch(/ADD `processing_attempt_token` varchar\(36\);/i);
  });

  it("deleted_at・status の単独インデックスを持つ(物理削除・stuck 再投入バッチのスキャン用)", () => {
    expect(sql).toMatch(/CREATE INDEX `notes_deleted_at_idx` ON `notes` \(`deleted_at`\)/i);
    expect(sql).toMatch(/CREATE INDEX `notes_status_idx` ON `notes` \(`status`\)/i);
  });
});

describe("notes テーブル拡張(M1-4a 埋め込み生成)のマイグレーション SQL", () => {
  const sql = readAllMigrationSql();

  it("embedding が nullable な vector(1536) である", () => {
    expect(sql).toMatch(/ADD `embedding` vector\(1536\);/i);
  });

  it("embedding_model が nullable な varchar(64) である", () => {
    expect(sql).toMatch(/ADD `embedding_model` varchar\(64\);/i);
  });

  it("embedding_fingerprint が nullable な varchar(64) である", () => {
    expect(sql).toMatch(/ADD `embedding_fingerprint` varchar\(64\);/i);
  });

  it("enrichment_status が pending/completed/failed の nullable な enum である", () => {
    expect(sql).toMatch(/ADD `enrichment_status` enum\('pending','completed','failed'\);/i);
  });

  it("enrichment_status の単独インデックスを持つ(回収バッチのスキャン用)", () => {
    expect(sql).toMatch(
      /CREATE INDEX `notes_enrichment_status_idx` ON `notes` \(`enrichment_status`\)/i,
    );
  });
});

/**
 * enrichment_status 列の追加(0004)を含むマイグレーションファイル名を探す
 * (§ enrichment_status 列の既存行バックフィル(0005) の前提となる列追加)。
 */
function findEnrichmentStatusAddMigrationFile(): string {
  const files = listMigrationFiles();
  const found = files.find((file) => /ADD `enrichment_status`/i.test(readMigrationFile(file)));
  expect(found).toBeDefined();
  return found as string;
}

/**
 * enrichment_status が NULL のまま取り残された既存行を pending にバックフィルする
 * マイグレーションファイル名を探す(0005。§ enrichment_status 列の既存行バックフィル 参照)。
 */
function findEnrichmentStatusBackfillMigrationFile(): string {
  const files = listMigrationFiles();
  const found = files.find((file) =>
    /SET `enrichment_status` = 'pending'/i.test(readMigrationFile(file)),
  );
  expect(found).toBeDefined();
  return found as string;
}

describe("enrichment_status 列の既存行バックフィル(0005。0004 の列追加で NULL のまま取り残された行の是正)", () => {
  const backfillFile = findEnrichmentStatusBackfillMigrationFile();
  const backfillSql = readMigrationFile(backfillFile);

  it("enrichment_status を追加したマイグレーション(0004)より後に存在する", () => {
    const addFile = findEnrichmentStatusAddMigrationFile();
    expect(backfillFile.localeCompare(addFile)).toBeGreaterThan(0);
  });

  it("enrichment_status IS NULL の行のみを対象とする(冪等性の担保)", () => {
    expect(backfillSql).toMatch(/WHERE `enrichment_status` IS NULL/i);
  });

  it("論理削除済み(deleted_at IS NOT NULL)の行を除外する", () => {
    expect(backfillSql).toMatch(/AND `deleted_at` IS NULL/i);
  });

  it("解析が成功した行(status = 'completed')のみを対象とする(解析失敗行は埋め込み入力が空のため除外)", () => {
    expect(backfillSql).toMatch(/AND `status` = 'completed'/i);
  });

  it("title/summary/body/extracted_text のいずれかが非空の行のみを対象とする(埋め込み入力を持たない行を除外。埋め込み入力の実体である note-enrichment-fingerprint の4セグメントのうち summary が条件から漏れていた不具合の回帰テスト)", () => {
    expect(backfillSql).toMatch(/`title` IS NOT NULL AND `title` != ''/i);
    expect(backfillSql).toMatch(/`summary` IS NOT NULL AND `summary` != ''/i);
    expect(backfillSql).toMatch(/`body` IS NOT NULL AND `body` != ''/i);
    expect(backfillSql).toMatch(/`extracted_text` IS NOT NULL AND `extracted_text` != ''/i);
  });

  it("tags のみを持つ行は対象外とする(tags は埋め込み入力として弱いため、意図的に条件へ含めない)", () => {
    expect(backfillSql).not.toMatch(/`tags`/i);
  });

  it("対象行の enrichment_status を pending に更新する", () => {
    expect(backfillSql).toMatch(/SET `enrichment_status` = 'pending'/i);
  });
});

describe("concepts 列の2段階 NOT NULL 化(既存行の移行手順。§ concepts 列の NOT NULL 化 参照)", () => {
  it("1段階目: concepts を nullable な json 列として追加し、既存行を '[]' で backfill する", () => {
    const addFile = findConceptsAddMigrationFile();
    const addSql = readMigrationFile(addFile);
    expect(addSql).toMatch(/ADD `concepts` json;/i);
    expect(addSql).toMatch(/UPDATE `notes` SET `concepts` = '\[\]' WHERE `concepts` IS NULL;/i);
  });

  it("2段階目: concepts を NOT NULL 化する MODIFY COLUMN が、1段階目より後のマイグレーションに存在する", () => {
    const addFile = findConceptsAddMigrationFile();
    const notNullFile = findConceptsNotNullMigrationFile();
    expect(notNullFile.localeCompare(addFile)).toBeGreaterThan(0);
  });
});
