import type { NoteStatus } from "@secondbrain/shared";
import { Badge } from "@/components/ui/badge";

export interface NoteStatusBadgeProps {
  status: NoteStatus;
}

/**
 * ノートの AI 解析ステージ(status)を示す小さなバッジ。completed のときは
 * 通常表示のため何も表示しない(design/handoffs/20260708-m1-mvp-screens.md 画面4)。
 */
export function NoteStatusBadge({ status }: Readonly<NoteStatusBadgeProps>) {
  if (status === "completed") {
    return null;
  }

  if (status === "failed") {
    return <Badge variant="destructive">処理に失敗しました</Badge>;
  }

  return <Badge variant="secondary">処理中</Badge>;
}
