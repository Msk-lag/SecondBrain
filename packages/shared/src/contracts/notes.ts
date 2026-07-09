import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const noteTypeSchema = z.enum(["memo", "url", "screenshot"]);
export type NoteType = z.infer<typeof noteTypeSchema>;

export const noteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: noteTypeSchema,
  title: z.string().nullable(),
  body: z.string(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof noteSchema>;

export const noteNotFoundSchema = z.object({ message: z.string() });

export const createMemoNoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  body: z.string().trim().min(1),
});
export type CreateMemoNoteRequest = z.infer<typeof createMemoNoteRequestSchema>;

export const updateNoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).nullable().optional(),
  body: z.string().trim().min(1).optional(),
  summary: z.string().trim().nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
});
export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

export const listNotesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;

export const listNotesResponseSchema = z.object({
  items: z.array(noteSchema),
  nextCursor: z.string().nullable(),
});

export const notesContract = c.router({
  list: {
    method: "GET",
    path: "/notes",
    query: listNotesQuerySchema,
    responses: {
      200: listNotesResponseSchema,
    },
  },
  get: {
    method: "GET",
    path: "/notes/:id",
    responses: {
      200: noteSchema,
      404: noteNotFoundSchema,
    },
  },
  create: {
    method: "POST",
    path: "/notes",
    body: createMemoNoteRequestSchema,
    responses: {
      201: noteSchema,
    },
  },
  update: {
    method: "PATCH",
    path: "/notes/:id",
    body: updateNoteRequestSchema,
    responses: {
      200: noteSchema,
      404: noteNotFoundSchema,
    },
  },
  delete: {
    method: "DELETE",
    path: "/notes/:id",
    responses: {
      204: z.void(),
      404: noteNotFoundSchema,
    },
  },
});
