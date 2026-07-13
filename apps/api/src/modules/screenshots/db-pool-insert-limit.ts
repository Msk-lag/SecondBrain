/**
 * screenshot アップロード経路専用の、in-flight な notes insert 試行数を管理するアプリ内
 * メモリ上のセマフォ(単一 worker/api プロセス前提。§ 対象外 の「複数 worker インスタンスでの
 * 厳密な排他制御」節と同じ前提を踏襲)。
 *
 * mysql2 の接続プール自体の待機キュー(queueLimit)超過エラーは安定した構造化コードを
 * 持たず、`err.message` を読まずに判定する規律と両立しない(§ 接続プール自体の待機キューを
 * 有限にする・Codex レビュー r32 指摘 [1] 参照)。そのため、insert を呼び出す前にアプリ層
 * 自身で上限を判定し、この専用エラー型を投げる。この経路は insert 自体を一度も呼んでいない
 * ため、DB へクエリが送信されていないことが instanceof チェックだけで確実に判定でき、
 * classifyUploadError から確定的な失敗として扱える。
 */
export class DbPoolInsertLimitError extends Error {
  constructor() {
    super("in-flight な notes insert 試行数が上限に達しています。");
    this.name = "DbPoolInsertLimitError";
    Object.setPrototypeOf(this, DbPoolInsertLimitError.prototype);
  }
}

export class DbPoolInsertSemaphore {
  private inFlight = 0;

  constructor(private readonly limit: number) {}

  /**
   * insert を呼び出す前に呼ぶ。上限に達している場合は insert を一度も呼ばずに
   * `DbPoolInsertLimitError` を投げる。
   */
  acquire(): void {
    if (this.inFlight >= this.limit) {
      throw new DbPoolInsertLimitError();
    }
    this.inFlight += 1;
  }

  /**
   * insert 呼び出し前にインクリメントした枠を解放する。
   *
   * 呼び出し元は、この解放を `Promise.race` によるアプリ側タイムアウトの完了(＝諦めた
   * 時点)ではなく、素の insert Promise 自体の settle(resolve/reject いずれも)に直接
   * 結び付けること(`insertPromise.then(() => release(), () => release())` を
   * `Promise.race` に渡す前の insert Promise へ直接アタッチする)。`Promise.race` の
   * タイムアウト完了を基準にすると、DB 側で実際にはまだ実行中の insert に対して枠が
   * 早期に解放されてしまい、「実際に in-flight な insert 試行数」を正しく制限できない
   * (§ 接続プール自体の待機キューを有限にする・Codex レビュー r33 指摘 [1] 参照)。
   */
  release(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
  }

  get inFlightCount(): number {
    return this.inFlight;
  }
}
