import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { MediaTable, POST_STATUSES } from "@/lib/db/schema";

// Date fields need to accept both Date objects and ISO strings (for JSON serialization)
const coercedDate = z.union([z.date(), z.string().pipe(z.coerce.date())]);

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
];

export const MediaSelectSchema = createSelectSchema(MediaTable, {
  key: z
    .string()
    .describe(
      "Identifies the file. It is the {key} of the media routes, and the file is served at /images/{key}.",
    ),
  url: z
    .string()
    .describe(
      "Address of the file. Use it as the src of an image in a post body. Replacing the file changes it.",
    ),
  width: z.number().int().nullable().describe("Pixels. Null when unknown."),
  height: z.number().int().nullable().describe("Pixels. Null when unknown."),
  sizeInBytes: z.number().int(),
  createdAt: coercedDate,
});

export const MediaListItemSchema = MediaSelectSchema.extend({
  postCount: z
    .number()
    .describe("How many posts use the image in their body or as their cover."),
  isCover: z
    .boolean()
    .describe("True when a post uses the image as its cover."),
});

export const MediaListPageSchema = z.object({
  items: z.array(MediaListItemSchema),
  nextCursor: z
    .number()
    .nullable()
    .describe("Pass as cursor to get the next page. Null on the last page."),
});

export const MediaStatsSchema = z.object({
  totalCount: z.number().int(),
  unusedCount: z
    .number()
    .int()
    .describe("Images no post uses and no Admin has as an avatar."),
  totalBytes: z.number().int(),
});

export const LinkedPostSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  slug: z.string(),
  status: z.enum(POST_STATUSES),
  isCover: z
    .boolean()
    .describe("True when the post uses the image as its cover."),
});

export const DeleteMediaResultSchema = z.object({ success: z.boolean() });

export const DeleteUnusedMediaResultSchema = z.object({
  data: z.object({
    count: z.number().int().describe("How many images were deleted."),
  }),
  error: z.null(),
});

export const MediaKeyInputSchema = z.strictObject({
  key: z.string(),
});

export const UpdateMediaNameInputSchema = z.strictObject({
  key: z.string().min(1),
  name: z.string().min(1),
});

export const GetMediaListInputSchema = z.strictObject({
  cursor: z.number().optional(),
  limit: z.number().optional(),
  search: z.string().optional(),
  unusedOnly: z.boolean().optional(),
});

export const ImportMediaUrlInputSchema = z.strictObject({
  url: z.string().min(1),
});

export type UpdateMediaNameInput = z.infer<typeof UpdateMediaNameInputSchema>;
export type GetMediaListInput = z.infer<typeof GetMediaListInputSchema>;
