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

// API Output Schemas
export const TagListItemSchema = TagSelectSchema.extend({
  postCount: z
    .number()
    .optional()
    .describe(
      "How many posts currently carry the tag, drafts included. Only returned when withCount=true.",
    ),
});

export const AdminTagWithCountSchema = TagWithCountSchema.extend({
  postCount: z
    .number()
    .describe("How many posts currently carry the tag, drafts included."),
  publicPostCount: z
    .number()
    .describe(
      "How many published posts show the tag on the public site, as of their last publish.",
    ),
});

export const DeleteTagResultSchema = z.object({ success: z.boolean() });

export const SetPostTagsResultSchema = z.object({
  saveToken: z
    .string()
    .describe(
      "The post's saveToken after the write, to state on your next save or publish.",
    ),
});

// API Input Schemas
const TagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .describe(
    "Name, trimmed: not empty, at most 50 characters. No other tag may have it, ignoring case: that answers 409 TAG_NAME_ALREADY_EXISTS.",
  );

export const CreateTagInputSchema = z.strictObject({
  name: TagNameInputSchema,
});

export const UpdateTagInputSchema = z.strictObject({
  id: z.number(),
  data: z.strictObject({
    name: TagNameInputSchema.optional(),
  }),
});

export const DeleteTagInputSchema = z.strictObject({
  id: z.number(),
});

export const GetTagsInputSchema = z.strictObject({
  sortBy: z.enum(["name", "createdAt", "postCount"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  withCount: z.boolean().optional(),
  publicOnly: z.boolean().optional(),
});

export const SetPostTagsInputSchema = z.strictObject({
  postId: z.number(),
  tagIds: z
    .array(z.number())
    .describe(
      "The ids of every tag the post should carry; an empty list removes them all. An id no tag has answers 404 TAG_NOT_FOUND and nothing is written.",
    ),
  saveToken: z
    .string()
    .optional()
    .describe(
      "The saveToken from your latest read or write of this post. If the post was saved since, nothing is written and the response is 409 EDIT_CONFLICT with the current token in data.saveToken: read the post again before deciding what to write. Omit it to write unconditionally.",
    ),
});

export const GetTagsByPostIdInputSchema = z.strictObject({
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
