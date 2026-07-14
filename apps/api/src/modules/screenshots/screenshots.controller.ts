import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Res,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { Response } from "express";
import { notes, type Database } from "@secondbrain/db";
import {
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  SCREENSHOT_UPLOAD_FILE_FIELD_NAME,
  toPublicNote,
  type AuthenticatedUser,
  type CreateScreenshotNoteResponse,
} from "@secondbrain/shared";
import { MinioClient, StorageTimeoutError } from "@secondbrain/storage";
import { DRIZZLE } from "../../db/db.module";
import { MINIO_CLIENT } from "../../storage/storage.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { NotesService } from "../notes/notes.service";
import { classifyUploadError } from "./sanitize-upload-error";
import { DbPoolInsertSemaphore } from "./db-pool-insert-limit";
import { enqueueScreenshotAnalysis } from "./screenshots.producer";
import { detectImageType } from "./detect-image-type";
import { UploadRateLimitGuard } from "./upload-rate-limit.guard";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// notes insert 自体のアプリケーションタイムアウト(§ アップロード時
// (ScreenshotsController.upload)の順序と補償 手順4 参照)。
const INSERT_TIMEOUT_MS = 10_000;
// apps/api/src/db/db.module.ts のプール connectionLimit と同値(§ 接続プール自体の
// 待機キューを有限にする 参照)。
const DB_POOL_INSERT_LIMIT = 10;

const UPLOAD_FAILED_BODY = { message: "画像の保存に失敗しました。もう一度お試しください。" };

/**
 * ts-rest 契約に含まれない、アップロード・画像配信の2エンドポイント
 * (§ 契約外エンドポイントの外部インターフェース定義 参照)。
 */
@UseGuards(JwtAuthGuard)
@Controller("notes")
export class ScreenshotsController {
  private readonly logger = new Logger(ScreenshotsController.name);
  private readonly insertSemaphore = new DbPoolInsertSemaphore(DB_POOL_INSERT_LIMIT);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(MINIO_CLIENT) private readonly minioClient: MinioClient,
    @InjectQueue(SCREENSHOT_ANALYSIS_QUEUE_NAME) private readonly screenshotAnalysisQueue: Queue,
    private readonly notesService: NotesService,
  ) {}

  // `UploadRateLimitGuard` は Multer/FileInterceptor より前に実行される(Guard →
  // Interceptor → Handler の順。§ アップロード制限の実行順序 参照。Codex コードレビュー
  // r4 指摘 [A-2] への対応)。JwtAuthGuard(コントローラーレベル)が先に `request.user` を
  // 設定している前提のため、必ずこの並び順を維持すること。in-flight 枠の解放(release)は
  // Guard 自身がレスポンスの finish/close イベントで行う(r5 指摘 [A-1] への対応。
  // このメソッド本体の finally では Multer がハンドラー到達前に例外を投げるケース
  // 〔ファイルサイズ超過等〕を解放できないため)。
  @Post("screenshots")
  @UseGuards(UploadRateLimitGuard)
  @UseInterceptors(
    FileInterceptor(SCREENSHOT_UPLOAD_FILE_FIELD_NAME, {
      // `fileSize` だけでは multipart のファイル以外の部分(フィールド数)に上限が無く、
      // 認証済みユーザーが大量のフィールドを含むリクエストを送ることでファイルサイズ制限を
      // 迂回してメモリを消費できる(Codex コードレビュー 2026-07-13 r2 指摘 [A-1] への対応)。
      // このエンドポイントはファイル1件のみを受理するため、ファイル数・非ファイル
      // フィールド数を1件・0件に制限する(`parts` の総数制限は正常な単一ファイル
      // アップロードまで拒否してしまったため使わない)。
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
    }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<CreateScreenshotNoteResponse> {
    if (!file) {
      throw new BadRequestException({ message: "画像ファイルが必要です。" });
    }

    const detected = detectImageType(file.buffer);
    if (!detected || !ALLOWED_IMAGE_MIME_TYPES.has(detected.mime)) {
      throw new UnsupportedMediaTypeException({
        message: "対応していない画像形式です。PNG・JPG・WebP のみアップロードできます。",
      });
    }

    const noteId = randomUUID();
    const imageKey = `screenshots/${user.id}/${noteId}.${detected.ext}`;

    try {
      await this.minioClient.uploadObject(imageKey, file.buffer, detected.mime);
    } catch (err) {
      const classified = classifyUploadError("minio_upload", noteId, err);
      this.logger.warn(`screenshot upload failed: ${JSON.stringify(classified)}`);
      // タイムアウト等でクライアント側は失敗と判定していても、サーバー側では PUT が
      // 完了している可能性がある(§ 外部通信タイムアウトの一貫適用 参照)。この後 DB 行は
      // 作られないため、放置すると回収経路(stuck 再投入・論理削除後の purge)が無い孤児
      // オブジェクトになる。削除はキーが存在しない場合も安全な操作なのでベストエフォートで
      // 常に試みる(Codex コードレビュー r3 指摘 [A-2] への対応)。
      try {
        await this.minioClient.deleteObject(imageKey);
      } catch (deleteErr) {
        const deleteClassified = classifyUploadError("compensation_delete", noteId, deleteErr);
        this.logger.warn(
          `screenshot upload compensation delete failed: ${JSON.stringify(deleteClassified)}`,
        );
      }
      throw new BadGatewayException(UPLOAD_FAILED_BODY);
    }

    try {
      await this.insertPendingNote(user.id, noteId, imageKey, detected.mime);
    } catch (err) {
      await this.compensateFailedInsert(noteId, imageKey, err);
    }

    // BullMQ 投入が失敗しても 201 を返す(note 行は有効な pending 状態のまま存在するため。
    // § アップロード時(ScreenshotsController.upload)の順序と補償 手順5 参照)。
    await enqueueScreenshotAnalysis(this.screenshotAnalysisQueue, noteId, 0);

    const created = await this.notesService.findOwned(user.id, noteId);
    if (!created) {
      throw new BadGatewayException(UPLOAD_FAILED_BODY);
    }
    return toPublicNote(created);
  }

  @Get(":id/image")
  async getImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    const note = await this.notesService.findOwned(user.id, id);
    if (!note || note.type !== "screenshot" || !note.imageKey) {
      res.status(404).json({ message: "画像が見つかりません。" });
      return;
    }

    // getObjectStream() の待機中にクライアントが切断した場合も検知できるよう、取得完了を
    // 待つ前に close の監視を始める(Codex コードレビュー r6 指摘 [A-1] への対応。以前は
    // 取得完了後にのみ登録しており、取得中〔MinIO 応答待ち〕の切断を取りこぼしていた)。
    let clientDisconnected = false;
    res.once("close", () => {
      clientDisconnected = true;
    });

    let sourceStream: Readable;
    try {
      sourceStream = await this.minioClient.getObjectStream(note.imageKey);
    } catch (err) {
      if (clientDisconnected) {
        return;
      }
      if (err instanceof StorageTimeoutError) {
        res.status(504).json({ message: "画像の取得がタイムアウトしました。" });
      } else {
        res.status(502).json({ message: "画像の取得に失敗しました。" });
      }
      return;
    }

    // 取得完了時点で既に切断済みなら、pipe() を開始せず直ちに MinIO ストリームを解放する。
    if (clientDisconnected) {
      sourceStream.destroy();
      return;
    }

    // ヘッダー送信前後で応答を分岐する(§ 画像配信はフェーズ別に応答を分ける 参照)。
    // getObjectStream() が既に解決している以上、この時点でのエラーはストリーミング開始
    // 前後いずれでも起こりうるため、res.headersSent で実際の送信状況を都度判定する。
    sourceStream.on("error", () => {
      if (res.headersSent) {
        sourceStream.destroy();
        res.destroy();
        return;
      }
      // `res.setHeader("Content-Type", ...)` は下記で先に呼ぶが、`headersSent` が false の
      // 間はまだ実際には送信されていないため上書き可能。Express の `res.json()` は
      // Content-Type が既に設定されている場合それを上書きしないため、画像用の
      // Content-Type を明示的に `application/json` へ戻してから JSON エラーを返す
      // (Codex コードレビュー r7 指摘 [A-4] への対応。最初のデータ送信前にストリームが
      // エラーになると、502 の JSON 応答が画像用 Content-Type のまま返っていた)。
      // headersSent 分岐(上)では sourceStream.destroy() を呼ぶ一方、この分岐では
      // 呼んでおらず非対称だった(Codex コードレビュー 2026-07-13 r4 指摘 [A-2] への対応。
      // エラーで自動終了しないストリームでは MinIO 側の接続が残留しうる)。
      sourceStream.destroy();
      res.setHeader("Content-Type", "application/json");
      res.status(502).json({ message: "画像の配信に失敗しました。" });
    });

    // クライアントがダウンロード完了前に切断した場合、`pipe()` は送信先(res)を終了させる
    // だけで、送信元(MinIOからのsourceStream。ひいては裏側のソケット)を自動では破棄しない。
    // 放置すると MinIO 側の接続・ストリームが残留する(Codex コードレビュー r5 指摘 [A-3]
    // への対応)。
    res.once("close", () => {
      if (!sourceStream.destroyed) {
        sourceStream.destroy();
      }
    });

    res.status(200);
    res.setHeader("Content-Type", note.imageMimeType ?? "application/octet-stream");
    sourceStream.pipe(res);
  }

  private async insertPendingNote(
    userId: string,
    noteId: string,
    imageKey: string,
    imageMimeType: string,
  ): Promise<void> {
    // insert を呼び出す前に上限を判定する(上限超過時は insert 自体を一度も呼ばない)。
    this.insertSemaphore.acquire();

    // drizzle-orm の QueryPromise は `.then()` を呼ぶたびに `execute()` を再実行する
    // 遅延 thenable であり、ネイティブ Promise ではない。`Promise.resolve()` でラップして
    // `.then()` の呼び出し(execute の実行)を1回だけに固定してから、以降のコードでは
    // ネイティブ Promise として扱う(統合テストで発見: このラップが無いと下記の
    // `insertPromise.then()` と `Promise.race` の双方が個別に execute() を呼び、
    // 同一 id で2回 insert が実行されて2回目が一意制約違反になる)。
    //
    // `this.db.insert(notes).values(...)` の評価自体が同期的に例外を投げた場合、
    // `Promise.resolve(...)` の呼び出しより前に例外が伝播するため、下記の
    // `insertPromise.then(...release...)` が一切登録されず、取得済みのセマフォ枠が
    // 永久に解放されない(Codex コードレビュー 2026-07-13 r9 指摘 [A-2] への対応)。
    // クエリ構築自体も try/catch の対象にし、同期例外時は即座に release してから
    // 同じエラーを再送出する(呼び出し元 upload() の catch → compensateFailedInsert への
    // エラー分類経路は変更しない)。
    let insertPromise: Promise<unknown>;
    try {
      insertPromise = Promise.resolve(
        this.db.insert(notes).values({
          id: noteId,
          userId,
          type: "screenshot",
          title: null,
          body: null,
          summary: null,
          tags: [],
          status: "pending",
          failureReason: null,
          imageKey,
          imageMimeType,
          concepts: [],
          extractedText: null,
          processingGeneration: 0,
        }),
      );
    } catch (err) {
      this.insertSemaphore.release();
      throw err;
    }
    // カウンタの解放は Promise.race のタイムアウトではなく、素の insert Promise 自体の
    // settle に直接結び付ける(§ 接続プール自体の待機キューを有限にする 参照)。
    insertPromise.then(
      () => this.insertSemaphore.release(),
      () => this.insertSemaphore.release(),
    );

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("notes insert timed out"));
      }, INSERT_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      await Promise.race([insertPromise, timeoutPromise]);
    } finally {
      // insertPromise が先に settle しても timeoutPromise のタイマーは既定では満了まで
      // 残り続ける(Codex コードレビュー r6 指摘 [A-4] と同種。`unref()` はプロセス終了を
      // 妨げないだけでタイマー自体は解放しない)。
      clearTimeout(timer!);
    }
  }

  /**
   * notes insert 失敗時、確定的な失敗(一意制約違反・アプリ層セマフォの上限超過)の場合のみ
   * MinIO へアップロード済みの画像をベストエフォートで削除してから 502 を返す。不確定な失敗
   * (接続断・タイムアウト等)では削除しない(再照会には頼らない。§ アップロード時
   * (ScreenshotsController.upload)の順序と補償 手順4 参照)。
   */
  private async compensateFailedInsert(
    noteId: string,
    imageKey: string,
    err: unknown,
  ): Promise<never> {
    const classified = classifyUploadError("db_insert", noteId, err);
    this.logger.warn(`screenshot note insert failed: ${JSON.stringify(classified)}`);

    if (classified.category === "db_insert_confirmed_failed") {
      try {
        await this.minioClient.deleteObject(imageKey);
      } catch (deleteErr) {
        const deleteClassified = classifyUploadError("compensation_delete", noteId, deleteErr);
        this.logger.warn(
          `screenshot compensation delete failed: ${JSON.stringify(deleteClassified)}`,
        );
      }
    }

    throw new BadGatewayException(UPLOAD_FAILED_BODY);
  }
}
