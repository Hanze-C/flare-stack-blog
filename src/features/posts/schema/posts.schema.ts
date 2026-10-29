import { createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";
import { PublicCategorySchema } from "@/features/categories/categories.schema";
import { TagSelectSchema } from "@/features/tags/tags.schema";
import type { PostStatus } from "@/lib/db/schema";
import { PostsTable } from "@/lib/db/schema";
import { NullableJsonContentSchema } from "./json-content.schema";

// Date fields need to accept both Date objects and ISO strings (for JSON serialization)
const coercedDate = z.union([z.date(), z.string().pipe(z.coerce.date())]);
const coercedDateNullable = coercedDate.nullable();

const PublicPostCoverSchema = z.object({
  key: z.string(),
  url: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

const AdminPostCoverSchema = PublicPostCoverSchema.extend({
  id: z.number().int(),
  fileName: z.string(),
});

const PublicSlugSchema = z
  .string()
  .nullable()
  .describe(
    "Slug of the live page at /post/{publicSlug}. It can differ from slug, the draft's, until the next publish. Null while the post is not published.",
  );

const MARKDOWN_RULES =
  "CommonMark with GFM tables, strikethrough and autolinks. It carries headings, bold, italic, strikethrough, inline code, links, nested bullet and numbered lists, block quotes, horizontal rules, hard line breaks, fenced code blocks with their language (a mermaid block renders as a diagram), tables with column alignment, inline math as $…$, block math with $$ alone on the lines before and after it, images and videos. A Bilibili or YouTube link alone in a paragraph is a video block. Headings stay within levels 2 to 4: when there is an H1 every heading moves one level down, and anything below level 4 becomes level 4. Images must be http(s) addresses or Media paths (/images/<key>). Table column widths are not carried, and a table cell holds a single line. Task list markers, footnotes and HTML stay plain text, and front matter is dropped.";

export const PostContentFormatSchema = z
  .enum(["json", "markdown"])
  .optional()
  .describe(
    `Format of the returned body. json, the default, returns contentJson, the editor's TipTap JSON. markdown returns contentMarkdown instead, and no contentJson. ${MARKDOWN_RULES}`,
  );
export type PostContentFormat = z.infer<typeof PostContentFormatSchema>;

const ContentMarkdownOutputSchema = z
  .string()
  .nullable()
  .optional()
  .describe(
    "The body as Markdown, returned in place of contentJson when the request asks for contentFormat=markdown. Null when the post has no body. Videos are written as their page link alone on a line, keeping the Bilibili part and start time; their title, cover and length are not carried.",
  );

const ContentMarkdownInputSchema = z
  .string()
  .optional()
  .describe(
    `The body as Markdown, converted to contentJson on the server. Send either contentJson or contentMarkdown, not both (CONTENT_FORMAT_AMBIGUOUS). ${MARKDOWN_RULES} Any other image, such as a local file path, is refused with MARKDOWN_IMAGE_INVALID naming it, so upload it as Media first. The title, cover and length of a video are looked up from its provider, or kept from the body being replaced, and stay empty when the lookup fails. Column widths of every table reset to equal.`,
  );

const SaveTokenSchema = z
  .string()
  .describe(
    "Opaque token that every write to the post replaces, including tags, category, cover, publish, unpublish and Post Revision restores. State it as saveToken when saving or publishing so the write is refused with 409 EDIT_CONFLICT if the post was saved since you read it.",
  );

const StatedSaveTokenSchema = z
  .string()
  .optional()
  .describe(
    "The saveToken from your latest read or write of this post. If the post was saved since, nothing is written and the response is 409 EDIT_CONFLICT with the current token in data.saveToken: read the post again before deciding what to write. Omit it to write unconditionally.",
  );

const PostSelectSchema = createSelectSchema(PostsTable, {
  saveToken: SaveTokenSchema,
  publishedAt: coercedDateNullable,
  pinnedAt: coercedDateNullable,
  createdAt: coercedDate,
  updatedAt: coercedDate,
}).omit({
  publicSnapshotJson: true,
  publicCategoryId: true,
});
/**
 * Strict on purpose, and narrower than the table.
 *
 * `createUpdateSchema` takes every column, so `id`, `createdAt` and
 * `updatedAt` were writable: a PATCH could move a row to another id or
 * backdate it, and `updatedAt` is the default list sort key, so a forged
 * value buried the post. They are the server's to set, never the client's.
 *
 * Publication is not a field either. A plain object would silently strip
 * these: a client that PATCHed `{ status: "published" }` got a 200 back and a
 * post that was still a draft. Rejecting the key says so instead.
 */
const PostUpdateSchema = createUpdateSchema(PostsTable, {
  contentJson: NullableJsonContentSchema.optional(),
})
  .omit({
    publicSnapshotJson: true,
    publicCategoryId: true,
    publicSlug: true,
    status: true,
    id: true,
    createdAt: true,
    updatedAt: true,
    saveToken: true,
  })
  .extend({ contentMarkdown: ContentMarkdownInputSchema })
  .strict();

export const PostItemSchema = PostSelectSchema.omit({
  saveToken: true,
  contentJson: true,
  publicSlug: true,
  coverMediaId: true,
  categoryId: true,
}).extend({
  tags: z.array(TagSelectSchema).optional(),
  category: PublicCategorySchema.nullable().catch(null),
  readTimeInMinutes: z.number().int().min(1),
  viewCount: z.number().int().nonnegative().optional(),
  cover: PublicPostCoverSchema.nullable().catch(null),
});
export const PostListResponseSchema = z.object({
  items: z.array(PostItemSchema),
  nextCursor: z.number().nullable(),
});
export const HOME_POSTS_PER_PAGE = 8;
export const HomePostsInputSchema = z.object({
  page: z.number().int().min(1).max(1_000_000).default(1),
});
export const HomePostsResponseSchema = z.object({
  items: z.array(PostItemSchema),
  page: z.number().int().positive(),
  totalPages: z.number().int().positive(),
});
export const PostWithTocSchema = PostSelectSchema.omit({
  saveToken: true,
  publicSlug: true,
  coverMediaId: true,
  categoryId: true,
})
  .extend({
    tags: z.array(TagSelectSchema).optional(),
    category: PublicCategorySchema.nullable().catch(null),
    readTimeInMinutes: z.number().int().min(1),
    toc: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        level: z.number(),
      }),
    ),
    cover: PublicPostCoverSchema.nullable().catch(null),
  })
  .nullable();

export const AdminPostSchema = PostSelectSchema.extend({
  contentJson: NullableJsonContentSchema.optional().describe(
    "The editable body as TipTap JSON. Not returned when the request asks for contentFormat=markdown.",
  ),
  contentMarkdown: ContentMarkdownOutputSchema,
  publicSlug: PublicSlugSchema,
  tags: z.array(TagSelectSchema).optional(),
  hasPublicSnapshot: z.boolean(),
  publicSnapshotContentJson: NullableJsonContentSchema,
  serverToday: z.string(),
  cover: AdminPostCoverSchema.nullable(),
}).nullable();

export function normalizePostTagName(
  tagName: string | undefined,
): string | undefined {
  return tagName === "" ? undefined : tagName;
}

export function normalizePostCategoryName(
  categoryName: string | undefined,
): string | undefined {
  return categoryName === "" ? undefined : categoryName;
}

export const PostTagNameSchema = z
  .string()
  .transform(normalizePostTagName)
  .optional();

export const PostCategoryNameSchema = z
  .string()
  .transform(normalizePostCategoryName)
  .optional();

export const GetPostsCursorInputSchema = z.object({
  cursor: z.number().optional(),
  limit: z.number().optional(),
  tagName: PostTagNameSchema,
  categoryName: PostCategoryNameSchema,
  uncategorized: z.boolean().optional(),
  excludePinned: z.boolean().optional(),
});

export const FindPostBySlugInputSchema = z.object({
  slug: z.string(),
});

const AdjacentPublicPostSchema = z.object({
  slug: z.string(),
  title: z.string(),
});

export const AdjacentPostsSchema = z.object({
  newer: AdjacentPublicPostSchema.nullable(),
  older: AdjacentPublicPostSchema.nullable(),
});

export type GetPostsCursorInput = z.infer<typeof GetPostsCursorInputSchema>;
export type FindPostBySlugInput = z.infer<typeof FindPostBySlugInputSchema>;

// Admin API Schemas
export const GenerateSlugInputSchema = z.object({
  title: z.string().optional(),
  excludeId: z.number().optional(),
});

const AdminTaxonomyFilterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("category"),
    id: z.number().int().positive(),
    scope: z.enum(["current", "public"]),
  }),
  z.object({
    kind: z.literal("tag"),
    id: z.number().int().positive(),
    scope: z.enum(["current", "public"]),
  }),
  z.object({
    kind: z.literal("uncategorized"),
    scope: z.enum(["current", "public"]),
  }),
]);
export type AdminTaxonomyFilter = z.infer<typeof AdminTaxonomyFilterSchema>;

export const GetPostsInputSchema = z.object({
  taxonomy: AdminTaxonomyFilterSchema.optional(),
  categoryId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only posts whose current category is this one."),
  uncategorized: z
    .boolean()
    .optional()
    .describe("Only posts without a current category."),
  tagId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only posts currently carrying this tag."),
  offset: z.number().optional(),
  limit: z.number().optional(),
  status: z.custom<PostStatus>().optional(),
  publicOnly: z.boolean().optional(),
  search: z.string().optional(),
  sortDir: z.enum(["ASC", "DESC"]).optional(),
  sortBy: z.enum(["publishedAt", "updatedAt", "id"]).optional(),
  includeContent: z
    .boolean()
    .optional()
    .describe(
      "Include the editable TipTap body of every item. Ignored when taxonomy.scope is public, where every column is read from the Public Content Snapshot instead. Pagination, the 50 item limit and every other response field stay the same.",
    ),
  contentFormat: PostContentFormatSchema,
});

const GetPostsCountInputSchema = GetPostsInputSchema.omit({
  offset: true,
  limit: true,
  sortDir: true,
  includeContent: true,
  contentFormat: true,
});

const AdminPostListItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  summary: z.string().nullable(),
  slug: z.string(),
  publicSlug: PublicSlugSchema,
  status: z.enum(["draft", "published"]),
  publishedAt: coercedDateNullable,
  pinnedAt: coercedDateNullable,
  createdAt: coercedDate,
  updatedAt: coercedDate,
  contentJson: NullableJsonContentSchema.optional().describe(
    "Only returned when the request asks for includeContent=true outside the public taxonomy scope.",
  ),
  contentMarkdown: ContentMarkdownOutputSchema,
  saveToken: SaveTokenSchema.optional().describe(
    "Returned together with the body (includeContent=true). Opaque token that every write to the post replaces; state it as saveToken when saving or publishing to refuse an Edit Conflict.",
  ),
});

const AdminPostStatusCountsSchema = z.object({
  draft: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
});
export type AdminPostStatusCounts = z.infer<typeof AdminPostStatusCountsSchema>;

export const AdminPostListPageSchema = z.object({
  items: z.array(AdminPostListItemSchema),
  total: z.number().int().nonnegative(),
  statusCounts: AdminPostStatusCountsSchema.describe(
    "Counts matching search, publicOnly, taxonomy scope and the category and tag filters before status filtering or pagination.",
  ),
});

export const FindPostByIdInputSchema = z.object({ id: z.number() });

export const AdminFindPostByIdInputSchema = FindPostByIdInputSchema.extend({
  contentFormat: PostContentFormatSchema,
});

/**
 * Content for a newly created draft. When present, `POST /api/admin/posts`
 * always creates a new draft instead of reusing an existing empty one, so
 * several external clients can create posts without colliding.
 */
const CreatePostDataSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .describe("Draft title; a unique slug is generated from it."),
  summary: z.string().nullable().optional(),
  contentJson: NullableJsonContentSchema.optional(),
  contentMarkdown: ContentMarkdownInputSchema,
});

export const CreatePostInputSchema = z
  .object({
    data: CreatePostDataSchema.optional().describe(
      "Omit to keep the get-or-create-empty-draft behavior used by the Admin UI.",
    ),
  })
  .optional();

export const UpdatePostInputSchema = z.object({
  id: z.number(),
  data: PostUpdateSchema,
  saveToken: StatedSaveTokenSchema,
});

export const DeletePostInputSchema = z.object({ id: z.number() });

export const PublishPostInputSchema = z.object({
  id: z.number(),
  saveToken: StatedSaveTokenSchema.describe(
    "The saveToken of the draft you read and want to go live. If the post was saved since, nothing is published and the response is 409 EDIT_CONFLICT with the current token in data.saveToken. Omit it to publish whatever the draft is now.",
  ),
});

export const PostWriteResultSchema = z.object({
  success: z.boolean(),
  saveToken: SaveTokenSchema.describe(
    "The post's saveToken after this write. State it on your next save or publish.",
  ),
});

export const EditConflictDataSchema = z.object({
  saveToken: z
    .string()
    .describe(
      "The post's current saveToken. Read the post again to see what changed; state this token only to overwrite it on purpose.",
    ),
});

export const UnpublishPostInputSchema = z.object({
  id: z.number(),
});

export type GenerateSlugInput = z.infer<typeof GenerateSlugInputSchema>;
export type GetPostsInput = z.infer<typeof GetPostsInputSchema>;
export type GetPostsCountInput = z.infer<typeof GetPostsCountInputSchema>;
export type FindPostByIdInput = z.infer<typeof FindPostByIdInputSchema>;
export type CreatePostData = z.infer<typeof CreatePostDataSchema>;
export type UpdatePostInput = z.infer<typeof UpdatePostInputSchema>;
export type DeletePostInput = z.infer<typeof DeletePostInputSchema>;
export type PublishPostInput = z.infer<typeof PublishPostInputSchema>;
export type UnpublishPostInput = z.infer<typeof UnpublishPostInputSchema>;
export type PostItem = z.infer<typeof PostItemSchema>;
export type PostWithToc = z.infer<typeof PostWithTocSchema>;

export const VideoMetaInputSchema = z.object({
  provider: z.enum(["bilibili", "youtube"]),
  videoId: z.string().max(32),
  page: z.number().int().positive().nullable().optional(),
});

export const VideoMetaSchema = z
  .object({
    title: z.string().nullable(),
    cover: z.string().nullable(),
    duration: z.number().int().nullable(),
  })
  .nullable();
