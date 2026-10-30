import { createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";
import {
  CategorySelectSchema,
  PublicCategorySchema,
} from "@/features/categories/categories.schema";
import { TagSelectSchema } from "@/features/tags/tags.schema";
import { POST_STATUSES, PostsTable } from "@/lib/db/schema";
import { atLeastOneField } from "@/lib/orpc/changes";
import {
  IdCursorSchema,
  PageOffsetSchema,
  pageLimitSchema,
} from "@/lib/orpc/pagination";
import { PathIdSchema } from "@/lib/orpc/path-ids";
import {
  isPostSlugFormat,
  isPostTitleFormat,
  POST_SLUG_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
} from "@/features/posts/utils/post-fields";
import {
  PUBLICATION_DATE_MAX,
  PUBLICATION_DATE_MIN,
  parsePublicationDate,
} from "@/features/posts/utils/date";
import { CONTENT_SIZE_RULES } from "@/features/posts/utils/post-content-size";
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

const HasUnpublishedChangesSchema = z
  .boolean()
  .describe(
    "True when the post is published and its draft differs from what was published: title, summary, slug, body, publication date, cover, category or tags. Changing a field back to its published value clears it, and publishing clears it. Pinning does not count. Always false for a draft post. publish makes the changes public; discard-changes makes the draft match the published version again.",
  );

const MARKDOWN_RULES =
  "CommonMark with GFM tables, strikethrough and autolinks. It carries headings, bold, italic, underline as ++text++, strikethrough, inline code, links, nested bullet and numbered lists, block quotes, horizontal rules, hard line breaks, fenced code blocks with their language (a mermaid block renders as a diagram), tables with column alignment, inline math as $…$, block math with $$ alone on the lines before and after it, images and videos. A Bilibili or YouTube link alone in a paragraph is a video block. Headings stay within levels 2 to 4: when there is an H1 every heading moves one level down, and anything below level 4 becomes level 4. Images must be http(s) addresses or Media paths (/images/<key>). Table column widths are not carried, and a table cell holds a single line. Task list markers, footnotes and HTML stay plain text, and front matter is dropped.";

export const PostContentFormatSchema = z
  .enum(["json", "markdown"])
  .optional()
  .describe(
    `Format of the returned body. json, the default, returns contentJson, the editor's TipTap JSON. markdown returns contentMarkdown instead, and no contentJson. ${MARKDOWN_RULES}`,
  );
export type PostContentFormat = z.infer<typeof PostContentFormatSchema>;

export const ContentMarkdownOutputSchema = z
  .string()
  .nullable()
  .optional()
  .describe(
    "The body as Markdown, returned in place of contentJson when the request asks for contentFormat=markdown. Null when the post has no body, which includes a body with no content, such as one empty paragraph. Videos are written as their page link alone on a line, keeping the Bilibili part and start time; their title, cover and length are not carried.",
  );

const SIZE_RULES = CONTENT_SIZE_RULES;

const LINK_RULES =
  "A link whose address has a scheme other than http, https, ftp, ftps, mailto, tel, callto, sms, cid or xmpp, such as javascript: or data:, is refused with CONTENT_LINK_INVALID naming it. Site paths, #fragments and relative addresses are kept.";

const ContentMarkdownInputSchema = z
  .string()
  .optional()
  .describe(
    `The body as Markdown, converted to contentJson on the server. Send either contentJson or contentMarkdown, not both (CONTENT_FORMAT_AMBIGUOUS). ${MARKDOWN_RULES} Any other image, such as a local file path, is refused with MARKDOWN_IMAGE_INVALID naming it, so upload it as Media first. ${LINK_RULES} ${SIZE_RULES} The title, cover and length of a video are looked up from its provider, or kept from the body being replaced, and stay empty when the lookup fails. Column widths of every table reset to equal. An empty string writes an empty body.`,
  );

const CONTENT_JSON_RULES =
  "The body as TipTap JSON, held to the same rules as Markdown: only the editor's node types (doc, text, paragraph, heading, blockquote, bulletList, orderedList, listItem, codeBlock, horizontalRule, hardBreak, table, tableRow, tableHeader, tableCell, image, video, inlineMath, blockMath) and mark types (bold, italic, underline, strike, code, link), and images whose src is an http(s) address or a Media path (/images/<key>). Anything else is refused with 400 CONTENT_JSON_INVALID naming it. Send either contentJson or contentMarkdown, not both.";

const ContentJsonInputSchema = NullableJsonContentSchema.optional().describe(
  `${CONTENT_JSON_RULES} ${LINK_RULES} ${SIZE_RULES}`,
);

const TITLE_FORMAT_RULE =
  "It cannot contain control or format characters (Unicode Cc or Cf, such as NUL, a tab, a zero width space or a bidirectional control); a zero width joiner inside an emoji is fine.";

const PostTitleInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(POST_TITLE_MAX_LENGTH)
  .refine(isPostTitleFormat, { message: TITLE_FORMAT_RULE })
  .describe(
    `Title, trimmed. It must not be empty and holds at most ${POST_TITLE_MAX_LENGTH} characters. ${TITLE_FORMAT_RULE}`,
  );

const SLUG_FORMAT_RULE =
  "cannot contain / ? # % \\, whitespace (no-break spaces included), or control or format characters (Unicode Cc or Cf, such as a zero width space), or be . or ..";

const PostSlugInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(POST_SLUG_MAX_LENGTH)
  .refine(isPostSlugFormat, { message: `A slug ${SLUG_FORMAT_RULE}.` })
  .describe(
    `Slug of the post's page, /post/<slug> once published, trimmed. It must not be empty, holds at most ${POST_SLUG_MAX_LENGTH} characters and ${SLUG_FORMAT_RULE}; letters of any script, such as Chinese, are fine. No other post may use it as its slug or as the slug of its live page, compared ignoring case and Unicode compatibility forms (NFKC, so fullwidth ＡＢＣ equals abc): that answers 409 SLUG_TAKEN. It is stored as written.`,
  );

const PUBLISHED_AT_RULES = `Publication date, ISO 8601: a date such as 2026-10-01, or a date and time such as 2026-10-01T08:30:00Z or 2026-10-01T08:30:00+08:00. A time with no Z or offset is read as UTC, and a date alone as the start of that day in UTC. A day the calendar does not have (2026-02-30) answers 400, and so does a date before ${PUBLICATION_DATE_MIN.toISOString().slice(0, 10)} or from ${PUBLICATION_DATE_MAX.toISOString().slice(0, 10)} on. Stored to the whole second. Publishing refuses it with 400 PUBLISHED_AT_IN_FUTURE while it is later than the server's current time. Null lets the next publish set it to that time.`;

const PUBLICATION_DATE_MESSAGES = {
  FORMAT:
    "Not an ISO 8601 date: write 2026-10-01 or 2026-10-01T08:30:00Z. A time with no Z or offset is read as UTC.",
  NOT_A_DATE: "The calendar has no such day.",
  NOT_A_TIME:
    "No such time of day: hours run from 00 to 23, minutes and seconds from 00 to 59.",
  NOT_AN_OFFSET:
    "No such UTC offset: write Z or an offset from -23:59 to +23:59, such as +08:00.",
  OUT_OF_RANGE: `A publication date is from ${PUBLICATION_DATE_MIN.toISOString().slice(0, 10)} to the end of ${PUBLICATION_DATE_MAX.getUTCFullYear() - 1}.`,
} as const;

/** Read as the strict ISO 8601 `parsePublicationDate` takes, then a Date. */
const PublishedAtInputSchema = z
  .string()
  .transform((value, ctx) => {
    const parsed = parsePublicationDate(value);
    if ("date" in parsed) return parsed.date;
    ctx.addIssue({
      code: "custom",
      message: PUBLICATION_DATE_MESSAGES[parsed.issue],
    });
    return z.NEVER;
  })
  .nullable()
  .optional()
  .describe(PUBLISHED_AT_RULES);

const SaveTokenSchema = z
  .string()
  .describe(
    "Opaque token that every save of the post's draft and every publish or unpublish replaces, including tags, category, cover and Post Revision restores; pinning keeps it. State it as saveToken when saving or publishing so the write is refused with 409 EDIT_CONFLICT if the post was saved since you read it.",
  );

export const StatedSaveTokenSchema = z
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
  draftFingerprint: true,
  publishedFingerprint: true,
  publicCategoryId: true,
  slugKey: true,
  publicSlugKey: true,
});

const SET_TAGS_HINT =
  "A Post's Tags are not set with its fields: set them with PUT /admin/posts/{postId}/tags, body { tagIds, saveToken }.";

/**
 * The refusal of an unknown field, pointing a `tagIds` sent with a Post's
 * fields to the operation that sets its Tags.
 */
function pointTagIdsToSetTags(issue: z.core.$ZodRawIssue) {
  if (issue.code !== "unrecognized_keys" || !issue.keys.includes("tagIds")) {
    return undefined;
  }
  const keys = issue.keys.map((key) => `"${key}"`).join(", ");
  return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${keys}. ${SET_TAGS_HINT}`;
}

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
 *
 * Pinning is not a field either: it takes effect at once, so it has its own
 * endpoints and a PATCH carrying `pinnedAt` is refused. Nor are Tags, which
 * have theirs too: a PATCH carrying `tagIds` is refused naming it.
 */
const PostUpdateSchema = z.strictObject(
  createUpdateSchema(PostsTable, {
    contentJson: ContentJsonInputSchema,
    title: PostTitleInputSchema.optional(),
    slug: PostSlugInputSchema.optional(),
    publishedAt: PublishedAtInputSchema,
  })
    .omit({
      publicSnapshotJson: true,
      publicCategoryId: true,
      publicSlug: true,
      pinnedAt: true,
      status: true,
      id: true,
      createdAt: true,
      updatedAt: true,
      saveToken: true,
      draftFingerprint: true,
      publishedFingerprint: true,
      slugKey: true,
      publicSlugKey: true,
    })
    .extend({ contentMarkdown: ContentMarkdownInputSchema }).shape,
  { error: pointTagIdsToSetTags },
);
const NonEmptyPostUpdateSchema = atLeastOneField(PostUpdateSchema);

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
  hasUnpublishedChanges: HasUnpublishedChangesSchema,
  publicSnapshotContentJson: NullableJsonContentSchema,
  serverToday: z.string(),
  cover: AdminPostCoverSchema.nullable(),
});

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
  cursor: IdCursorSchema.optional(),
  limit: pageLimitSchema(50).optional(),
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
export const GenerateSlugInputSchema = z.strictObject({
  title: z.string().optional(),
  excludeId: z.number().optional(),
});

const AdminTaxonomyFilterSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("category"),
    id: z.number().int().positive(),
    scope: z.enum(["current", "public"]),
  }),
  z.strictObject({
    kind: z.literal("tag"),
    id: z.number().int().positive(),
    scope: z.enum(["current", "public"]),
  }),
  z.strictObject({
    kind: z.literal("uncategorized"),
    scope: z.enum(["current", "public"]),
  }),
]);
export type AdminTaxonomyFilter = z.infer<typeof AdminTaxonomyFilterSchema>;

export const GetPostsInputSchema = z.strictObject({
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
  offset: PageOffsetSchema.optional(),
  limit: pageLimitSchema(50).optional(),
  status: z.enum(POST_STATUSES).optional(),
  hasUnpublishedChanges: z
    .boolean()
    .optional()
    .describe(
      "true: only published posts that have unpublished changes (their item has hasUnpublishedChanges true). Combines with the other filters; with status=draft nothing matches. total and pagination follow the filter, and statusCounts.unpublishedChanges is the count it selects. false or omitted: no filtering by it.",
    ),
  publicOnly: z.boolean().optional(),
  search: z.string().optional(),
  sortDir: z.enum(["ASC", "DESC"]).optional(),
  sortBy: z
    .enum(["publishedAt", "updatedAt", "createdAt", "id"])
    .optional()
    .describe(
      "Sort key. Defaults to updatedAt. createdAt is when the post was first created and never changes. Ties are broken by id in the sortDir direction.",
    ),
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
  status: z.enum(POST_STATUSES),
  hasUnpublishedChanges: HasUnpublishedChangesSchema,
  publishedAt: coercedDateNullable,
  pinnedAt: coercedDateNullable,
  createdAt: coercedDate,
  updatedAt: coercedDate,
  contentJson: NullableJsonContentSchema.optional().describe(
    "Only returned when the request asks for includeContent=true outside the public taxonomy scope.",
  ),
  contentMarkdown: ContentMarkdownOutputSchema,
  saveToken: SaveTokenSchema.optional().describe(
    "Returned together with the body (includeContent=true). Opaque token that every save, publish or unpublish replaces; state it as saveToken when saving or publishing to refuse an Edit Conflict.",
  ),
});

const AdminPostStatusCountsSchema = z.object({
  draft: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  unpublishedChanges: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "How many of the published posts have unpublished changes. Counted within published, not in addition to it.",
    ),
});
export type AdminPostStatusCounts = z.infer<typeof AdminPostStatusCountsSchema>;

export const AdminPostListPageSchema = z.object({
  items: z.array(AdminPostListItemSchema),
  total: z.number().int().nonnegative(),
  statusCounts: AdminPostStatusCountsSchema.describe(
    "Counts matching search, publicOnly, taxonomy scope and the category and tag filters before status filtering or pagination.",
  ),
});

export const FindPostByIdInputSchema = z.strictObject({ id: PathIdSchema });

export const AdminFindPostByIdInputSchema = FindPostByIdInputSchema.extend({
  contentFormat: PostContentFormatSchema,
});

/**
 * Content for a newly created draft. When present, `POST /api/admin/posts`
 * always creates a new draft instead of reusing an existing empty one, so
 * several external clients can create posts without colliding.
 */
const CreatePostDataSchema = z.strictObject(
  {
    title: PostTitleInputSchema.describe(
      `Draft title, trimmed: not empty, at most ${POST_TITLE_MAX_LENGTH} characters. ${TITLE_FORMAT_RULE} A unique slug is generated from it.`,
    ),
    summary: z.string().nullable().optional(),
    contentJson: ContentJsonInputSchema,
    contentMarkdown: ContentMarkdownInputSchema,
  },
  { error: pointTagIdsToSetTags },
);

export const CreatePostInputSchema = z
  .strictObject({
    data: CreatePostDataSchema.optional().describe(
      "Omit to keep the get-or-create-empty-draft behavior used by the Admin UI.",
    ),
  })
  .optional();

export const UpdatePostInputSchema = z.strictObject(
  {
    id: PathIdSchema,
    data: NonEmptyPostUpdateSchema.describe(
      "The fields to change; at least one, or the request answers 400.",
    ),
    saveToken: StatedSaveTokenSchema,
    contentFormat: PostContentFormatSchema,
  },
  { error: pointTagIdsToSetTags },
);

export const DeletePostInputSchema = z.strictObject({ id: PathIdSchema });

export const PublishPostInputSchema = z.strictObject({
  id: PathIdSchema,
  saveToken: StatedSaveTokenSchema.describe(
    "The saveToken of the draft you read and want to go live. If the post was saved since, nothing is published and the response is 409 EDIT_CONFLICT with the current token in data.saveToken. Omit it to publish whatever the draft is now.",
  ),
});

export const CreatePostResultSchema = z.object({
  id: z.number().int(),
  saveToken: SaveTokenSchema.describe(
    "The draft's saveToken. State it on your next save or publish.",
  ),
});

export const DeletePostResultSchema = z.object({ success: z.boolean() });

export const GenerateSlugResultSchema = z.object({
  slug: z
    .string()
    .describe(
      "A slug made from the title that no other post uses. A number is appended when the plain one is taken.",
    ),
});

// A post as a write answers it: the draft's own fields with its category and
// tags. The public snapshot and the change-tracking fingerprints stay out.
const WrittenPostSchema = PostSelectSchema.extend({
  contentJson: NullableJsonContentSchema.describe(
    "The editable body as TipTap JSON.",
  ),
  category: CategorySelectSchema.nullable().describe(
    "The draft's category. Null when it has none.",
  ),
  tags: z.array(TagSelectSchema).describe("The draft's tags."),
});

export const UpdatedPostSchema = WrittenPostSchema.omit({
  publicSlug: true,
}).extend({
  contentJson: NullableJsonContentSchema.optional().describe(
    "The editable body as TipTap JSON. Not returned when the request asks for contentFormat=markdown.",
  ),
  contentMarkdown: ContentMarkdownOutputSchema,
  hasUnpublishedChanges: HasUnpublishedChangesSchema,
});

export const RestorePostRevisionResultSchema = z.object({
  post: WrittenPostSchema.extend({ publicSlug: PublicSlugSchema }).describe(
    "The post after the restore. post.saveToken is its token after the restore.",
  ),
  restored: z
    .boolean()
    .describe(
      "False when the draft already matched the revision, so nothing was written and the saveToken is unchanged.",
    ),
  revisionId: z.number().int().describe("The revision that was restored."),
});

export const DeletePostRevisionsResultSchema = z.object({
  deletedIds: z
    .array(z.number().int())
    .describe("Ids of the revisions that were deleted."),
  deletedCount: z.number().int(),
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

export const UnpublishPostInputSchema = z.strictObject({
  id: PathIdSchema,
});

export const DiscardPostChangesInputSchema = z.strictObject({
  id: PathIdSchema,
  saveToken: StatedSaveTokenSchema.describe(
    "The saveToken of the draft you read and mean to discard. If the post was saved since, nothing is written and the response is 409 EDIT_CONFLICT with the current token in data.saveToken. Omit it to discard whatever the draft is now.",
  ),
});

export const PinPostInputSchema = z.strictObject({
  id: PathIdSchema,
});

export const UnpinPostInputSchema = z.strictObject({
  id: PathIdSchema,
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
export type DiscardPostChangesInput = z.infer<
  typeof DiscardPostChangesInputSchema
>;
export type PinPostInput = z.infer<typeof PinPostInputSchema>;
export type UnpinPostInput = z.infer<typeof UnpinPostInputSchema>;
export type PostItem = z.infer<typeof PostItemSchema>;
export type PostWithToc = z.infer<typeof PostWithTocSchema>;

export const VideoMetaInputSchema = z.strictObject({
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
