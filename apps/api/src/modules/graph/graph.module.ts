import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module";
import { GraphController } from "./graph.controller";
import { GraphService } from "./graph.service";

// DbModule は @Global() のため実際には未 import でも DRIZZLE を注入できるが、
// このモジュール単体で依存関係が読み取れるよう明示的に import する
// (notes.module.ts 等の既存モジュールと異なり、GraphModule は DbModule 以外に
// キュー等の依存を持たないため、この import が唯一の外部依存の手がかりになる)。
@Module({
  imports: [DbModule],
  controllers: [GraphController],
  providers: [GraphService],
})
export class GraphModule {}
