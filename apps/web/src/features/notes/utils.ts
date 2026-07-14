const FALLBACK_TITLE_LENGTH = 30;

/**
 * タイトル未入力のメモは一覧・詳細で本文冒頭を仮タイトルとして表示する
 * (計画のユーザー確認事項2)。DB には null のまま保存され、表示側でのみ補う。
 */
export function getDisplayTitle(note: { title: string | null; body: string | null }): string {
  if (note.title) {
    return note.title;
  }
  // screenshot ノートは本文(body)が常に null のため(§ notes テーブル拡張・削除の
  // 論理削除化 参照)、この場合のみ「無題」にフォールバックする。
  const trimmed = (note.body ?? "").trim();
  if (!trimmed) {
    return "無題";
  }
  if (trimmed.length <= FALLBACK_TITLE_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, FALLBACK_TITLE_LENGTH)}…`;
}
