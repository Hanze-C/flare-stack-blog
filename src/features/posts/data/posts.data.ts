import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  like,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type {
  PostFilters,
  SortDirection,
  SortField,
} from "@/features/posts/data/helper";
import {
  adminPostTextColumns,
  buildPostOrderByClause,
  buildPostWhereClause,
  unpublishedChangesSql,
} from "@/features/posts/data/helper";
import { mapSnapshotToPublicPost } from "@/features/posts/public-snapshot";
import type { PostItem } from "@/features/posts/schema/posts.schema";
import { HOME_POSTS_PER_PAGE } from "@/features/posts/schema/posts.schema";
import { isPostBodyEmpty } from "@/features/posts/utils/is-post-body-empty";
import type { PostStatus, PublicPostSnapshot } from "@/lib/db/schema";
import {
  CategoriesTable,
  PostsTable,
  PostTagsTable,
  TagsTable,
} from "@/lib/db/schema";

const DEFAULT_PAGE_SIZE = 12;
const DEFAULT_SITEMAP_BATCH_SIZE = 500;

const snapshotPublishedAt = sql<string>`json_extract(${PostsTable.publicSnapshotJson}, '$.publishedAt')`;
const snapshotPinnedAt = sql<string>`json_extract(${PostsTable.publicSnapshotJson}, '$.pinnedAt')`;

async function hydratePublicPosts(
  db: DB,
  rows: Array<{
    id: number;
    status: PostStatus;
    createdAt: Date;
    updatedAt: Date;
    publicSnapshotJson: PublicPostSnapshot | null;
  }>,
): Promise<Array<PostItem>> {
  if (rows.length === 0) return [];
  const assignments = await db.query.PostsTable.findMany({
    columns: { id: true },
    where: inArray(
      PostsTable.id,
      rows.map((row) => row.id),
    ),
    with: { category: true, postTags: { with: { tag: true } } },
  });
  const byId = new Map(assignments.map((post) => [post.id, post]));
  return rows.flatMap((row) => {
    const assignment = byId.get(row.id);
    const item = mapSnapshotToPublicPost(
      row,
      assignment?.postTags.map(({ tag }) => tag) ?? [],
      assignment?.category
        ? { id: assignment.category.id, name: assignment.category.name }
        : null,
    );
    return item ? [item] : [];
  });
}

export type SitemapPostRow = {
  id: number;
  slug: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  publishedAt: Date | null;
};

export async function insertPost(db: DB, data: typeof PostsTable.$inferInsert) {
  const [post] = await db.insert(PostsTable).values(data).returning();
  return post;
}

export async function getPosts(
  db: DB,
  options: PostFilters & {
    offset?: number;
    limit?: number;
    sortDir?: SortDirection;
    sortBy?: SortField;
    includeContent?: boolean;
  } = {},
) {
  const {
    offset = 0,
    limit = DEFAULT_PAGE_SIZE,
    sortDir,
    sortBy,
    includeContent = false,
    ...filters
  } = options;
  const whereClause = buildPostWhereClause(filters);
  const publicScope = filters.taxonomy?.scope === "public";
  const orderByClause = buildPostOrderByClause(sortDir, sortBy, publicScope);
  const snapshotDate = (field: "publishedAt" | "pinnedAt") =>
    sql<
      string | null
    >`json_extract(${PostsTable.publicSnapshotJson}, ${`$.${field}`})`.mapWith(
      (value) => (value == null ? null : new Date(value)),
    );

  const posts = await db
    .select({
      id: PostsTable.id,
      ...adminPostTextColumns(filters.taxonomy),
      publicSlug: PostsTable.publicSlug,
      status: PostsTable.status,
      hasUnpublishedChanges: unpublishedChangesSql().mapWith(Boolean),
      publishedAt: publicScope
        ? snapshotDate("publishedAt")
        : PostsTable.publishedAt,
      pinnedAt: publicScope ? snapshotDate("pinnedAt") : PostsTable.pinnedAt,
      categoryId: PostsTable.categoryId,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
      // contentJson is the editable draft body. In public-snapshot scope every
      // other column is read from publicSnapshotJson, so returning the draft
      // here would mix an unpublished body into a published row.
      ...(includeContent && !publicScope
        ? {
            contentJson: PostsTable.contentJson,
            saveToken: PostsTable.saveToken,
          }
        : {}),
    })
    .from(PostsTable)
    .limit(Math.min(limit, 50))
    .offset(offset)
    .orderBy(...orderByClause)
    .where(whereClause);
  return posts;
}

export async function getPostsCount(db: DB, options: PostFilters = {}) {
  const whereClause = buildPostWhereClause(options);
  const totalNumberofPosts = await db
    .select({ count: count() })
    .from(PostsTable)
    .where(whereClause);
  return totalNumberofPosts[0].count;
}

/** Status facets use the same search predicate as the paginated Admin list. */
export async function getAdminPostStatusCounts(
  db: DB,
  options: Omit<PostFilters, "status" | "hasUnpublishedChanges"> = {},
) {
  const rows = await db
    .select({
      status: PostsTable.status,
      count: count(),
      unpublishedChanges: sql<number>`coalesce(sum(${unpublishedChangesSql()}), 0)`,
    })
    .from(PostsTable)
    .where(buildPostWhereClause(options))
    .groupBy(PostsTable.status);
  const published = rows.find((row) => row.status === "published");
  return {
    draft: rows.find((row) => row.status === "draft")?.count ?? 0,
    published: published?.count ?? 0,
    unpublishedChanges: Number(published?.unpublishedChanges ?? 0),
  };
}

export async function findReusableEmptyDraft(db: DB) {
  const rows = await db
    .select({
      id: PostsTable.id,
      contentJson: PostsTable.contentJson,
      saveToken: PostsTable.saveToken,
    })
    .from(PostsTable)
    .where(
      and(eq(PostsTable.status, "draft"), sql`trim(${PostsTable.title}) = ''`),
    )
    .orderBy(desc(PostsTable.updatedAt))
    .limit(20);

  for (const row of rows) {
    if (isPostBodyEmpty(row.contentJson)) {
      return row;
    }
  }
  return null;
}

/**
 * Get posts with cursor-based pagination
 * @param cursor - The id of the last item from previous page
 * @param limit - Number of items per page
 */
export async function getPostsCursor(
  db: DB,
  options: {
    cursor?: number;
    limit?: number;
    publicOnly?: boolean;
    tagName?: string;
    categoryName?: string;
    uncategorized?: boolean;
    excludePinned?: boolean;
  } = {},
): Promise<{
  items: Array<PostItem>;
  nextCursor: number | null;
}> {
  const {
    cursor,
    limit = DEFAULT_PAGE_SIZE,
    publicOnly = true,
    tagName,
    categoryName,
    uncategorized,
    excludePinned,
  } = options;

  const conditions = [];
  const baseConditions = buildPostWhereClause({ publicOnly });
  if (baseConditions) {
    conditions.push(baseConditions);
  }

  if (cursor) {
    const reference = await db.query.PostsTable.findFirst({
      where: eq(PostsTable.id, cursor),
      columns: { publicSnapshotJson: true, id: true },
    });
    const referencePublishedAt = reference?.publicSnapshotJson?.publishedAt;

    if (referencePublishedAt) {
      conditions.push(
        or(
          lt(snapshotPublishedAt, referencePublishedAt),
          and(
            eq(snapshotPublishedAt, referencePublishedAt),
            lt(PostsTable.id, reference.id),
          ),
        ),
      );
    } else if (reference) {
      conditions.push(lt(PostsTable.id, cursor));
    }
  }

  if (tagName) {
    conditions.push(
      sql`EXISTS (
        SELECT 1
        FROM ${PostTagsTable}
        JOIN ${TagsTable} ON ${TagsTable.id} = ${PostTagsTable.tagId}
        WHERE ${PostTagsTable.postId} = ${PostsTable.id} AND ${TagsTable.name} = ${tagName}
      )`,
    );
  }

  if (uncategorized) {
    conditions.push(sql`${PostsTable.categoryId} IS NULL`);
  } else if (categoryName) {
    conditions.push(
      sql`EXISTS (
        SELECT 1
        FROM ${CategoriesTable}
        WHERE ${CategoriesTable.id} = ${PostsTable.categoryId}
          AND ${CategoriesTable.name} = ${categoryName}
      )`,
    );
  }

  if (excludePinned) {
    conditions.push(sql`${snapshotPinnedAt} IS NULL`);
  }

  const itemsWithPotentialNext = await db
    .select({
      id: PostsTable.id,
      status: PostsTable.status,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
    })
    .from(PostsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(snapshotPublishedAt), desc(PostsTable.id))
    .limit(limit + 1);

  const hasMore = itemsWithPotentialNext.length > limit;
  const rows = itemsWithPotentialNext.slice(0, limit);
  const items = await hydratePublicPosts(db, rows);
  const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

  return { items, nextCursor };
}

export async function getHomePosts(db: DB, requestedPage: number) {
  const total = await getPostsCount(db, { publicOnly: true });
  const totalPages = Math.max(1, Math.ceil(total / HOME_POSTS_PER_PAGE));
  const page = Math.min(requestedPage, totalPages);
  const rows = await db
    .select({
      id: PostsTable.id,
      status: PostsTable.status,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
    })
    .from(PostsTable)
    .where(buildPostWhereClause({ publicOnly: true }))
    .orderBy(
      desc(snapshotPinnedAt),
      desc(snapshotPublishedAt),
      desc(PostsTable.id),
    )
    .limit(HOME_POSTS_PER_PAGE)
    .offset((page - 1) * HOME_POSTS_PER_PAGE);
  return { items: await hydratePublicPosts(db, rows), page, totalPages };
}

export async function getPublishedPostsForSitemapBatch(
  db: DB,
  options: {
    cursor?: {
      publishedAt: Date;
      id: number;
    };
    limit?: number;
  } = {},
): Promise<Array<SitemapPostRow>> {
  const { cursor, limit = DEFAULT_SITEMAP_BATCH_SIZE } = options;

  const cursorPublishedAt = cursor?.publishedAt.toISOString();
  const rows = await db
    .select({
      id: PostsTable.id,
      publicSlug: PostsTable.publicSlug,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
    })
    .from(PostsTable)
    .where(
      and(
        isNotNull(PostsTable.publicSnapshotJson),
        cursor && cursorPublishedAt
          ? or(
              lt(snapshotPublishedAt, cursorPublishedAt),
              and(
                eq(snapshotPublishedAt, cursorPublishedAt),
                lt(PostsTable.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(snapshotPublishedAt), desc(PostsTable.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    slug: row.publicSlug ?? row.publicSnapshotJson?.slug ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publicSnapshotJson
      ? new Date(row.publicSnapshotJson.publishedAt)
      : null,
  }));
}

export async function findPostById(db: DB, id: number) {
  const post = await db.query.PostsTable.findFirst({
    where: eq(PostsTable.id, id),
    with: {
      postTags: {
        with: {
          tag: true,
        },
      },
      category: true,
    },
  });

  if (!post) return null;

  const tags = post.postTags.map((pt) => pt.tag);
  const { postTags, ...rest } = post;
  return { ...rest, tags };
}

export async function findPinnedPosts(db: DB) {
  const rows = await db
    .select({
      id: PostsTable.id,
      status: PostsTable.status,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
    })
    .from(PostsTable)
    .where(
      and(
        isNotNull(PostsTable.publicSnapshotJson),
        sql`${snapshotPinnedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(snapshotPinnedAt));

  return hydratePublicPosts(db, rows);
}

export async function findPostsByIds(db: DB, ids: number[]) {
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: PostsTable.id,
      status: PostsTable.status,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
    })
    .from(PostsTable)
    .where(
      and(
        isNotNull(PostsTable.publicSnapshotJson),
        inArray(PostsTable.id, ids),
      ),
    );

  return hydratePublicPosts(db, rows);
}

export async function findPostBySlug(
  db: DB,
  slug: string,
  options: { publicOnly?: boolean } = {},
) {
  const { publicOnly = false } = options;

  if (publicOnly) {
    const row = await db.query.PostsTable.findFirst({
      where: and(
        eq(PostsTable.publicSlug, slug),
        isNotNull(PostsTable.publicSnapshotJson),
      ),
    });
    if (!row?.publicSnapshotJson) return null;
    const [item] = await hydratePublicPosts(db, [row]);
    return item
      ? {
          ...row,
          ...item,
          contentJson: row.publicSnapshotJson.contentJson,
          tags: item.tags ?? [],
        }
      : null;
  }

  const post = await db.query.PostsTable.findFirst({
    where: eq(PostsTable.slug, slug),
    with: {
      postTags: {
        with: {
          tag: true,
        },
      },
    },
  });

  if (!post) return null;

  const tags = post.postTags.map((pt) => pt.tag);
  const { postTags, ...rest } = post;
  return { ...rest, tags };
}

/**
 * Matches the Post, and with `saveToken` only while the Post still carries
 * it, so the compare and the write are one statement.
 */
function postToWrite(id: number, saveToken: string | undefined) {
  return and(
    eq(PostsTable.id, id),
    saveToken === undefined ? undefined : eq(PostsTable.saveToken, saveToken),
  );
}

/**
 * Re-reads the Post after a write, keeping the saveToken that write set: a
 * later write may land before the read, and its token must not be handed out
 * for content the caller never saw.
 */
async function findWrittenPost(db: DB, id: number, saveToken: string) {
  const post = await findPostById(db, id);
  return post && { ...post, saveToken };
}

const FINGERPRINTED_FIELDS = [
  "title",
  "summary",
  "slug",
  "contentJson",
  "publishedAt",
  "coverMediaId",
  "categoryId",
] as const;

/** Whether a write touches a field Unpublished Changes are decided by. */
function changesFingerprintedFields(data: object) {
  return FINGERPRINTED_FIELDS.some((field) => field in data);
}

/**
 * Returns null when no Post was written: it does not exist, or it no longer
 * carries the stated `saveToken`.
 */
export async function updatePost(
  db: DB,
  id: number,
  data: Partial<
    Omit<
      typeof PostsTable.$inferInsert,
      | "id"
      | "createdAt"
      | "saveToken"
      | "draftFingerprint"
      | "publishedFingerprint"
    >
  >,
  options: { saveToken?: string } = {},
) {
  const [written] = await db
    .update(PostsTable)
    .set({
      ...data,
      ...(changesFingerprintedFields(data) && { draftFingerprint: null }),
    })
    .where(postToWrite(id, options.saveToken))
    .returning({ saveToken: PostsTable.saveToken });
  if (!written) return null;
  return await findWrittenPost(db, id, written.saveToken);
}

const fingerprintMissing = and(
  eq(PostsTable.status, "published"),
  or(
    sql`${PostsTable.draftFingerprint} IS NULL`,
    sql`${PostsTable.publishedFingerprint} IS NULL`,
  ),
);

/** Whether a Published Post has a fingerprint not computed yet. */
export async function hasPostsWithoutFingerprints(db: DB) {
  const [row] = await db
    .select({ id: PostsTable.id })
    .from(PostsTable)
    .where(fingerprintMissing)
    .limit(1);
  return row !== undefined;
}

/** Published Posts with a fingerprint not computed yet, by ascending id. */
export async function findPostsWithoutFingerprints(
  db: DB,
  options: { postId?: number; afterId?: number; limit: number },
) {
  return await db.query.PostsTable.findMany({
    where: and(
      fingerprintMissing,
      options.postId === undefined
        ? undefined
        : eq(PostsTable.id, options.postId),
      options.afterId === undefined
        ? undefined
        : gt(PostsTable.id, options.afterId),
    ),
    orderBy: asc(PostsTable.id),
    limit: options.limit,
    with: { postTags: true },
  });
}

/**
 * Stores computed fingerprints, each only where the column is still null and
 * only while the Post carries the token it was computed from. Leaves the
 * token and updatedAt as they are: computing a fingerprint is not a save.
 */
export async function writeFingerprints(
  db: DB,
  rows: Array<{
    id: number;
    saveToken: string;
    draftFingerprint: string | null;
    publishedFingerprint: string | null;
  }>,
) {
  const [head, ...rest] = rows.map((row) =>
    db
      .update(PostsTable)
      .set({
        draftFingerprint: sql`coalesce(${PostsTable.draftFingerprint}, ${row.draftFingerprint})`,
        publishedFingerprint: sql`coalesce(${PostsTable.publishedFingerprint}, ${row.publishedFingerprint})`,
        saveToken: sql`${PostsTable.saveToken}`,
        updatedAt: sql`${PostsTable.updatedAt}`,
      })
      .where(
        and(eq(PostsTable.id, row.id), eq(PostsTable.saveToken, row.saveToken)),
      ),
  );
  if (!head) return;
  await db.batch([head, ...rest]);
}

/** Ids of the Categories and Tags that exist, for ignoring deleted ones. */
export async function findAssignableIds(db: DB) {
  const [categories, tags] = await Promise.all([
    db.select({ id: CategoriesTable.id }).from(CategoriesTable),
    db.select({ id: TagsTable.id }).from(TagsTable),
  ]);
  return {
    categoryIds: new Set(categories.map((row) => row.id)),
    tagIds: new Set(tags.map((row) => row.id)),
  };
}

export async function findPostSaveToken(db: DB, id: number) {
  const [post] = await db
    .select({ saveToken: PostsTable.saveToken })
    .from(PostsTable)
    .where(eq(PostsTable.id, id));
  return post?.saveToken ?? null;
}

export async function touchPostUpdatedAt(db: DB, id: number) {
  const [post] = await db
    .update(PostsTable)
    .set({ updatedAt: new Date(), draftFingerprint: null })
    .where(eq(PostsTable.id, id))
    .returning({
      publicSlug: PostsTable.publicSlug,
      saveToken: PostsTable.saveToken,
    });
  return post;
}

/**
 * Writes the Public Content Snapshot together with the draft fields publishing
 * settles, in one statement. With `saveToken`, nothing is written unless the
 * Post still carries it, so what goes live is the draft that was read.
 */
export async function writePublicSnapshot(
  db: DB,
  id: number,
  snapshot: PublicPostSnapshot,
  options: {
    draft?: Partial<
      Pick<typeof PostsTable.$inferInsert, "publishedAt" | "contentJson">
    >;
    saveToken?: string;
    /**
     * Fingerprint of the draft as read, which the snapshot was built from.
     * `readSaveToken` is the token that read carried.
     */
    fingerprint?: { value: string; readSaveToken: string };
  } = {},
) {
  const draft = options.draft ?? {};
  const [written] = await db
    .update(PostsTable)
    .set({
      ...draft,
      publicSnapshotJson: snapshot,
      publicSlug: snapshot.slug,
      status: "published",
      ...(options.fingerprint && {
        publishedFingerprint: options.fingerprint.value,
        // The draft is that read only if nothing saved it since; otherwise
        // leave it to be computed again.
        draftFingerprint: sql`CASE WHEN ${PostsTable.saveToken} = ${options.fingerprint.readSaveToken} THEN ${options.fingerprint.value} END`,
      }),
      // Publishing alone leaves updatedAt; settling a draft field moves it.
      ...(Object.keys(draft).length === 0 && {
        updatedAt: sql`${PostsTable.updatedAt}`,
      }),
    })
    .where(postToWrite(id, options.saveToken))
    .returning({ saveToken: PostsTable.saveToken });
  if (!written) return null;
  return await findWrittenPost(db, id, written.saveToken);
}

export async function clearPublicSnapshot(db: DB, id: number) {
  const [written] = await db
    .update(PostsTable)
    .set({
      publicSnapshotJson: null,
      publicSlug: null,
      publishedFingerprint: null,
      status: "draft",
      updatedAt: sql`${PostsTable.updatedAt}`,
    })
    .where(eq(PostsTable.id, id))
    .returning({ saveToken: PostsTable.saveToken });
  if (!written) return null;
  return await findWrittenPost(db, id, written.saveToken);
}

export async function publicSlugExists(
  db: DB,
  slug: string,
  options: { excludeId?: number } = {},
): Promise<boolean> {
  const conditions = [eq(PostsTable.publicSlug, slug)];
  if (options.excludeId) {
    conditions.push(ne(PostsTable.id, options.excludeId));
  }
  const results = await db
    .select({ id: PostsTable.id })
    .from(PostsTable)
    .where(and(...conditions))
    .limit(1);
  return results.length > 0;
}

export async function deletePost(db: DB, id: number) {
  await db.delete(PostsTable).where(eq(PostsTable.id, id));
}

/**
 * Check if a slug exists in the database
 * @param slug - The slug to check
 * @param excludeId - Optional post ID to exclude (for editing existing posts)
 */
export async function slugExists(
  db: DB,
  slug: string,
  options: { excludeId?: number } = {},
): Promise<boolean> {
  const { excludeId } = options;
  const conditions = [eq(PostsTable.slug, slug)];
  if (excludeId) {
    conditions.push(ne(PostsTable.id, excludeId));
  }
  const results = await db
    .select({ id: PostsTable.id })
    .from(PostsTable)
    .where(and(...conditions))
    .limit(1);
  return results.length > 0;
}

/**
 * 找出所有长得像 "baseSlug-%" 的 Slug
 */
export async function findSimilarSlugs(
  db: DB,
  baseSlug: string,
  options: { excludeId?: number } = {},
) {
  const conditions = [like(PostsTable.slug, `${baseSlug}-%`)];

  // 如果是编辑文章，要排除掉自己，防止把自己算作冲突
  if (options.excludeId) {
    conditions.push(ne(PostsTable.id, options.excludeId));
  }

  const results = await db
    .select({ slug: PostsTable.slug })
    .from(PostsTable)
    .where(and(...conditions));

  return results.map((r) => r.slug);
}

export async function findAdjacentPublicPosts(db: DB, slug: string) {
  const currentPost = await db.query.PostsTable.findFirst({
    where: and(
      eq(PostsTable.publicSlug, slug),
      isNotNull(PostsTable.publicSnapshotJson),
    ),
    columns: { id: true, publicSnapshotJson: true },
  });

  const publishedAt = currentPost?.publicSnapshotJson?.publishedAt;
  if (!currentPost || !publishedAt) {
    return { newer: null, older: null };
  }

  const snapshotTitle = sql<string>`json_extract(${PostsTable.publicSnapshotJson}, '$.title')`;

  const [newer] = await db
    .select({
      slug: PostsTable.publicSlug,
      title: snapshotTitle,
    })
    .from(PostsTable)
    .where(
      and(
        isNotNull(PostsTable.publicSnapshotJson),
        isNotNull(PostsTable.publicSlug),
        or(
          gt(snapshotPublishedAt, publishedAt),
          and(
            eq(snapshotPublishedAt, publishedAt),
            gt(PostsTable.id, currentPost.id),
          ),
        ),
      ),
    )
    .orderBy(asc(snapshotPublishedAt), asc(PostsTable.id))
    .limit(1);

  const [older] = await db
    .select({
      slug: PostsTable.publicSlug,
      title: snapshotTitle,
    })
    .from(PostsTable)
    .where(
      and(
        isNotNull(PostsTable.publicSnapshotJson),
        isNotNull(PostsTable.publicSlug),
        or(
          lt(snapshotPublishedAt, publishedAt),
          and(
            eq(snapshotPublishedAt, publishedAt),
            lt(PostsTable.id, currentPost.id),
          ),
        ),
      ),
    )
    .orderBy(desc(snapshotPublishedAt), desc(PostsTable.id))
    .limit(1);

  return {
    newer: newer?.slug ? { slug: newer.slug, title: newer.title } : null,
    older: older?.slug ? { slug: older.slug, title: older.title } : null,
  };
}
