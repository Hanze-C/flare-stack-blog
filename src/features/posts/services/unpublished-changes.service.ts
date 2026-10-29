import * as PostRevisionRepo from "@/features/posts/data/post-revisions.data";
import * as PostRepo from "@/features/posts/data/posts.data";
import type { PostRevisionSnapshot } from "@/features/posts/schema/post-revisions.schema";
import { PostRevisionSnapshotSchema } from "@/features/posts/schema/post-revisions.schema";
import { calculateDraftFingerprint } from "@/features/posts/utils/sync";

/*
 * Unpublished Changes compare two fingerprints kept on the Post: the draft's
 * and the one taken when it was published (see the columns on posts.table).
 * Publishing writes both. Every other write that can change the fingerprinted
 * fields only clears the draft's, in the same statement as the write, so
 * there is no window in which it is stale. A null fingerprint on a Published
 * Post means "compute me", and this module computes it: from the current
 * draft for the draft's, and from the Post's latest publish Post Revision,
 * which holds the draft as it was published, for the published one. The Admin
 * reads settle before they answer.
 *
 * This is also how Posts published before fingerprints existed are filled
 * in: the migration cannot hash, so it leaves null (migration 0026).
 */

// Each chunk costs a handful of D1 queries whatever its size, and the
// published fingerprint query binds one id per Post.
const SETTLE_CHUNK_SIZE = 50;

export type Fingerprints = {
  draftFingerprint: string | null;
  publishedFingerprint: string | null;
};

type Assignable = Awaited<ReturnType<typeof PostRepo.findAssignableIds>>;

/**
 * Fingerprint of a Post Revision's snapshot as published. A Category or Tag
 * deleted since is left out, as it was taken off the Post and off the public
 * site when it was deleted.
 */
export function fingerprintOfRevision(
  snapshot: PostRevisionSnapshot,
  assignable: Assignable,
) {
  return calculateDraftFingerprint({
    title: snapshot.title,
    summary: snapshot.summary,
    slug: snapshot.slug,
    contentJson: snapshot.contentJson,
    publishedAt: snapshot.publishedAt,
    tagIds: snapshot.tagIds.filter((id) => assignable.tagIds.has(id)),
    coverMediaId: snapshot.coverMediaId,
    categoryId:
      snapshot.categoryId !== null &&
      assignable.categoryIds.has(snapshot.categoryId)
        ? snapshot.categoryId
        : null,
  });
}

type PostToSettle = Awaited<
  ReturnType<typeof PostRepo.findPostsWithoutFingerprints>
>[number];

async function draftFingerprintOf(post: PostToSettle) {
  return calculateDraftFingerprint({
    ...post,
    tagIds: post.postTags.map((postTag) => postTag.tagId),
  });
}

/**
 * Fingerprint of the draft as published. Without a usable publish revision it
 * is built from the snapshot's fields and the draft's body, which takes the
 * body to be unchanged: the snapshot's own body is highlighted and cannot be
 * compared with the draft's.
 */
async function publishedFingerprintOf(
  post: PostToSettle,
  revision: { snapshotJson: unknown } | undefined,
  assignable: Assignable,
) {
  const parsed = PostRevisionSnapshotSchema.safeParse(revision?.snapshotJson);
  if (parsed.success) return fingerprintOfRevision(parsed.data, assignable);

  const snapshot = post.publicSnapshotJson;
  if (!snapshot) return draftFingerprintOf(post);
  return fingerprintOfRevision(
    {
      title: snapshot.title,
      summary: snapshot.summary,
      slug: snapshot.slug,
      status: "published",
      publishedAt: snapshot.publishedAt,
      contentJson: post.contentJson,
      tagIds: snapshot.tagIds,
      categoryId: snapshot.categoryId,
      coverMediaId: snapshot.cover?.mediaId ?? null,
    },
    assignable,
  );
}

/**
 * Computes the fingerprints that are still null on Published Posts, one Post
 * with `postId` or all of them, and returns what each Post now has. Posts with
 * nothing to compute are not in the result.
 */
export async function settleFingerprints(
  db: DB,
  options: { postId?: number } = {},
) {
  const settled = new Map<number, Fingerprints>();
  if (
    options.postId === undefined &&
    !(await PostRepo.hasPostsWithoutFingerprints(db))
  ) {
    return settled;
  }

  let afterId: number | undefined;
  for (;;) {
    const posts = await PostRepo.findPostsWithoutFingerprints(db, {
      postId: options.postId,
      afterId,
      limit: SETTLE_CHUNK_SIZE,
    });
    if (posts.length === 0) break;
    afterId = posts[posts.length - 1].id;

    const needPublished = posts.filter(
      (post) => post.publishedFingerprint === null,
    );
    const [revisions, assignable] =
      needPublished.length === 0
        ? [[], { categoryIds: new Set<number>(), tagIds: new Set<number>() }]
        : await Promise.all([
            PostRevisionRepo.findLatestPublishRevisions(
              db,
              needPublished.map((post) => post.id),
            ),
            PostRepo.findAssignableIds(db),
          ]);
    const revisionByPost = new Map(
      revisions.map((revision) => [revision.postId, revision]),
    );

    const computed = await Promise.all(
      posts.map(async (post) => ({
        id: post.id,
        saveToken: post.saveToken,
        draftFingerprint:
          post.draftFingerprint ?? (await draftFingerprintOf(post)),
        publishedFingerprint:
          post.publishedFingerprint ??
          (await publishedFingerprintOf(
            post,
            revisionByPost.get(post.id),
            assignable,
          )),
      })),
    );
    await PostRepo.writeFingerprints(db, computed);
    for (const row of computed) {
      settled.set(row.id, {
        draftFingerprint: row.draftFingerprint,
        publishedFingerprint: row.publishedFingerprint,
      });
    }

    if (options.postId !== undefined || posts.length < SETTLE_CHUNK_SIZE) break;
  }
  return settled;
}
