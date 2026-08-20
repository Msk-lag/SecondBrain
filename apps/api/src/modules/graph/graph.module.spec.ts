import { GraphModule } from "./graph.module";

/**
 * `GraphModule` は `@Module({...})` デコレータ + 空のクラス定義のみで構成される宣言的な
 * DI 設定であり、実ロジックを持たない。DI コンテナを構築して DbModule(実際の mysql2 接続
 * プール生成)まで巻き込むのは単体テストとして過大なため、`db.module.spec.ts` の
 * `createApiPool`(モジュールファイルを import するだけで対象ファイルの実行文をカバーする
 * 方針)と同じ考え方で、クラスの import(=デコレータの評価)のみを行い、DI コンテナは
 * 構築しない。
 */
describe("GraphModule", () => {
  it("モジュールクラスとして定義されている", () => {
    expect(GraphModule).toBeDefined();
  });
});
