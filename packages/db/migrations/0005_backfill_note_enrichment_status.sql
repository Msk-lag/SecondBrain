-- データ是正のみの migration(スキーマ変更なし)。
--
-- 背景: 0004 で notes に enrichment_status 列を追加したが、既存行は NULL のまま
-- 取り残された。埋め込み生成の回収バッチ(note-enrichment-requeue)は
-- enrichment_status = 'pending' の行しか拾わないため、NULL のままでは
-- 対象ノートの埋め込みが永遠に生成されない。
--
-- これは F-21(バックフィル機能: 全ノートを遡って埋め込みを生成する機能)とは別物であり、
-- 今回追加した列の初期値を実態に合わせるための一度きりのデータ補正である。
--
-- 除外条件:
-- - deleted_at が NULL でない(論理削除済み)行は対象外。
-- - status <> 'completed' の行(screenshot の解析失敗など)は対象外。
--   解析が失敗した行は埋め込み入力(title/summary/body/extracted_text)が実質空であることが多く、
--   対象に含めても embedding 生成 API を呼ばず completed に落ちるだけで
--   バックフィルする価値が無いため。
-- - title/summary/body/extracted_text のいずれも持たない行は対象外(tags のみの行は
--   埋め込み入力として弱いため、この補正の対象には含めない。埋め込み入力の実体は
--   apps/worker/src/queues/note-enrichment/note-enrichment-fingerprint.ts の
--   title/summary/body(無ければ extracted_text)/tags の4セグメントだが、
--   このバックフィルでは tags のみで他が空の行を意図的に除外している)。
--
-- 冪等性: enrichment_status IS NULL の行のみを対象とするため、再実行しても
-- 既に pending/completed/failed になった行には影響しない。
UPDATE `notes`
SET `enrichment_status` = 'pending'
WHERE `enrichment_status` IS NULL
  AND `deleted_at` IS NULL
  AND `status` = 'completed'
  AND (
    (`title` IS NOT NULL AND `title` != '')
    OR (`summary` IS NOT NULL AND `summary` != '')
    OR (`body` IS NOT NULL AND `body` != '')
    OR (`extracted_text` IS NOT NULL AND `extracted_text` != '')
  );
