import type { JSONContent } from "@tiptap/react";
import { eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  extractAllImageKeys,
  replaceImageSrc,
} from "@/features/posts/utils/content";
import {
  MediaTable,
  PostMediaTable,
  PostRevisionMediaTable,
  PostRevisionsTable,
  PostsTable,
  type PublicPostSnapshot,
} from "@/lib/db/schema";

export type PostMediaSource = {
  id: number;
  contentJson: JSONContent | null;
  publicSnapshotJson: PublicPostSnapshot | null;
  coverMediaId: number | null;
};

function referencedImageKeys(
  contentJson: JSONContent | null | undefined,
  snapshotContentJson: JSONContent | null | undefined,
) {
  return [
    ...new Set([
      ...extractAllImageKeys(contentJson ?? null),
      ...extractAllImageKeys(snapshotContentJson ?? null),
    ]),
  ];
}

function sameMediaIdSet(existing: Array<number>, next: Set<number>) {
  if (existing.length !== next.size) return false;
  return existing.every((mediaId) => next.has(mediaId));
}

export async function syncPostMedia(db: DB, post: PostMediaSource) {
  const usedKeys = referencedImageKeys(
    post.contentJson,
    post.publicSnapshotJson?.contentJson,
  );
  const snapshotCoverKey = post.publicSnapshotJson?.cover?.key;
  if (snapshotCoverKey) usedKeys.push(snapshotCoverKey);

  const mediaIds = new Set<number>();
  if (post.coverMediaId != null) mediaIds.add(post.coverMediaId);
  if (post.publicSnapshotJson?.cover?.mediaId != null) {
    mediaIds.add(post.publicSnapshotJson.cover.mediaId);
  }

  if (usedKeys.length > 0) {
    const mediaRecords = await db
      .select({ id: MediaTable.id })
      .from(MediaTable)
      .where(inArray(MediaTable.key, usedKeys));
    for (const media of mediaRecords) mediaIds.add(media.id);
  }

  const existing = await db
    .select({ mediaId: PostMediaTable.mediaId })
    .from(PostMediaTable)
    .where(eq(PostMediaTable.postId, post.id));
  const existingIds = existing.map((row) => row.mediaId);
  if (sameMediaIdSet(existingIds, mediaIds)) return;

  const statements: Array<BatchItem<"sqlite">> = [];
  if (existingIds.length > 0) {
    statements.push(
      db.delete(PostMediaTable).where(eq(PostMediaTable.postId, post.id)),
    );
  }
  if (mediaIds.size > 0) {
    statements.push(
      db.insert(PostMediaTable).values(
        [...mediaIds].map((mediaId) => ({
          postId: post.id,
          mediaId,
        })),
      ),
    );
  }
  const [head, ...rest] = statements;
  if (!head) return;
  await db.batch([head, ...rest]);
}

/**
 * Points the editable body of every Post that uses a Media item at `src`.
 * The Public Content Snapshot keeps its URL until the Post is published again.
 */
export async function pointDraftImagesAt(
  db: DB,
  media: { id: number; key: string },
  src: string,
) {
  const rows = await db
    .select({ id: PostsTable.id, contentJson: PostsTable.contentJson })
    .from(PostsTable)
    .innerJoin(PostMediaTable, eq(PostsTable.id, PostMediaTable.postId))
    .where(eq(PostMediaTable.mediaId, media.id));

  const statements: Array<BatchItem<"sqlite">> = [];
  for (const row of rows) {
    const contentJson = replaceImageSrc(row.contentJson, media.key, src);
    if (!contentJson) continue;
    statements.push(
      db
        .update(PostsTable)
        .set({
          contentJson,
          draftFingerprint: null,
          updatedAt: sql`${PostsTable.updatedAt}`,
        })
        .where(eq(PostsTable.id, row.id)),
    );
  }
  const [head, ...rest] = statements;
  if (!head) return;
  await db.batch([head, ...rest]);
}

export async function getPostsByMediaKey(db: DB, key: string) {
  const [posts, revisionPosts] = await Promise.all([
    db
      .select({
        id: PostsTable.id,
        title: PostsTable.title,
        slug: PostsTable.slug,
        status: PostsTable.status,
        coverMediaId: PostsTable.coverMediaId,
        snapshotCoverKey: sql<
          string | null
        >`json_extract(${PostsTable.publicSnapshotJson}, '$.cover.key')`,
        snapshotCoverMediaId: sql<
          number | null
        >`json_extract(${PostsTable.publicSnapshotJson}, '$.cover.mediaId')`,
        mediaId: MediaTable.id,
      })
      .from(PostsTable)
      .innerJoin(PostMediaTable, eq(PostsTable.id, PostMediaTable.postId))
      .innerJoin(MediaTable, eq(MediaTable.id, PostMediaTable.mediaId))
      .where(eq(MediaTable.key, key)),
    db
      .selectDistinct({
        id: PostsTable.id,
        title: PostsTable.title,
        slug: PostsTable.slug,
        status: PostsTable.status,
      })
      .from(PostRevisionMediaTable)
      .innerJoin(MediaTable, eq(MediaTable.id, PostRevisionMediaTable.mediaId))
      .innerJoin(
        PostRevisionsTable,
        eq(PostRevisionsTable.id, PostRevisionMediaTable.revisionId),
      )
      .innerJoin(PostsTable, eq(PostsTable.id, PostRevisionsTable.postId))
      .where(eq(MediaTable.key, key)),
  ]);

  const linked = posts.map((post) => ({
    id: post.id,
    title: post.title,
    slug: post.slug,
    status: post.status,
    isCover:
      post.coverMediaId === post.mediaId ||
      post.snapshotCoverKey === key ||
      (post.snapshotCoverMediaId != null &&
        Number(post.snapshotCoverMediaId) === post.mediaId),
    revisionsOnly: false,
  }));
  const listed = new Set(linked.map((post) => post.id));
  for (const post of revisionPosts) {
    if (listed.has(post.id)) continue;
    linked.push({ ...post, isCover: false, revisionsOnly: true });
  }
  return linked;
}

export async function isMediaInUse(db: DB, key: string): Promise<boolean> {
  const [inPost, inRevision] = await Promise.all([
    db
      .select({ id: PostMediaTable.postId })
      .from(PostMediaTable)
      .innerJoin(MediaTable, eq(MediaTable.id, PostMediaTable.mediaId))
      .where(eq(MediaTable.key, key))
      .limit(1),
    db
      .select({ id: PostRevisionMediaTable.revisionId })
      .from(PostRevisionMediaTable)
      .innerJoin(MediaTable, eq(MediaTable.id, PostRevisionMediaTable.mediaId))
      .where(eq(MediaTable.key, key))
      .limit(1),
  ]);

  return inPost.length > 0 || inRevision.length > 0;
}

export async function getLinkedMediaKeys(
  db: DB,
  keys: Array<string>,
): Promise<Array<string>> {
  if (keys.length === 0) return [];

  const [inPosts, inRevisions] = await Promise.all([
    db
      .selectDistinct({ key: MediaTable.key })
      .from(MediaTable)
      .innerJoin(PostMediaTable, eq(MediaTable.id, PostMediaTable.mediaId))
      .where(inArray(MediaTable.key, keys)),
    db
      .selectDistinct({ key: MediaTable.key })
      .from(MediaTable)
      .innerJoin(
        PostRevisionMediaTable,
        eq(MediaTable.id, PostRevisionMediaTable.mediaId),
      )
      .where(inArray(MediaTable.key, keys)),
  ]);

  return [...new Set([...inPosts, ...inRevisions].map((r) => r.key))];
}
