import { Controller, UseGuards } from "@nestjs/common";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import { notesContract, type AuthenticatedUser, type Note as NoteDto } from "@secondbrain/shared";
import type { Note as DbNote } from "@secondbrain/db";
import { NotesService } from "./notes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";

function toNoteDto(note: DbNote): NoteDto {
  return {
    id: note.id,
    userId: note.userId,
    type: note.type,
    title: note.title,
    body: note.body,
    summary: note.summary,
    tags: note.tags,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

const NOT_FOUND_BODY = { message: "ノートが見つかりません。" };

@UseGuards(JwtAuthGuard)
@Controller()
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @TsRestHandler(notesContract.list)
  list(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.list, async ({ query }) => {
      const result = await this.notesService.list(user.id, query);
      return {
        status: 200 as const,
        body: {
          items: result.items.map(toNoteDto),
          nextCursor: result.nextCursor,
        },
      };
    });
  }

  @TsRestHandler(notesContract.get)
  get(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.get, async ({ params }) => {
      const note = await this.notesService.findOwned(user.id, params.id);
      if (!note) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      return { status: 200 as const, body: toNoteDto(note) };
    });
  }

  @TsRestHandler(notesContract.create)
  create(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.create, async ({ body }) => {
      const note = await this.notesService.create(user.id, body);
      return { status: 201 as const, body: toNoteDto(note) };
    });
  }

  @TsRestHandler(notesContract.update)
  update(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.update, async ({ params, body }) => {
      const note = await this.notesService.update(user.id, params.id, body);
      if (!note) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      return { status: 200 as const, body: toNoteDto(note) };
    });
  }

  @TsRestHandler(notesContract.delete)
  delete(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.delete, async ({ params }) => {
      const removed = await this.notesService.remove(user.id, params.id);
      if (!removed) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      return { status: 204 as const, body: undefined };
    });
  }
}
