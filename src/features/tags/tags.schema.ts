import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { TagsTable } from "@/lib/db/schema";

// Date fields need to accept both Date objects and ISO strings (for JSON serialization)
const coercedDate = z.union([z.date(), z.string().pipe(z.coerce.date())]);

export const TagSelectSchema = createSelectSchema(TagsTable, {
  createdAt: coercedDate,
});

export const TagWithCountSchema = TagSelectSchema.extend({
  postCount: z.number(),
});

// API Input Schemas
export const CreateTagInputSchema = z.object({
  name: z.string().min(1).max(50),
});

export const UpdateTagInputSchema = z.object({
  id: z.number(),
  data: z.object({
    name: z.string().min(1).max(50).optional(),
  }),
});

export const DeleteTagInputSchema = z.object({
  id: z.number(),
});

export const GetTagsInputSchema = z.object({
  sortBy: z.enum(["name", "createdAt", "postCount"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  withCount: z.boolean().optional(),
  publicOnly: z.boolean().optional(),
});

export const SetPostTagsInputSchema = z.object({
  postId: z.number(),
  tagIds: z.array(z.number()),
  saveToken: z
    .string()
    .optional()
    .describe(
      "The saveToken from your latest read or write of this post. If the post was saved since, nothing is written and the response is 409 EDIT_CONFLICT with the current token in data.saveToken: read the post again before deciding what to write. Omit it to write unconditionally.",
    ),
});

export const GetTagsByPostIdInputSchema = z.object({
  postId: z.number(),
});

// Type exports
export type Tag = z.infer<typeof TagSelectSchema>;
export type CreateTagInput = z.infer<typeof CreateTagInputSchema>;
export type UpdateTagInput = z.infer<typeof UpdateTagInputSchema>;
export type DeleteTagInput = z.infer<typeof DeleteTagInputSchema>;
export type GetTagsInput = z.infer<typeof GetTagsInputSchema>;
export type SetPostTagsInput = z.infer<typeof SetPostTagsInputSchema>;
export type GetTagsByPostIdInput = z.infer<typeof GetTagsByPostIdInputSchema>;
export type TagWithCount = z.infer<typeof TagWithCountSchema>;
