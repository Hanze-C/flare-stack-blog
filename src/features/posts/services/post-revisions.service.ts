import { invalidate } from "@/features/cache/public-cache";
import * as MediaRepo from "@/features/media/data/media.data";
import { syncPostMedia } from "@/features/posts/data/post-media.data";
import * as PostRevisionRepo from "@/features/posts/data/post-revisions.data";
import * as PostRepo from "@/features/posts/data/posts.data";
import type { DiscardPostChangesInput } from "@/features/posts/schema/posts.schema";
import * as UnpublishedChangesService from "@/features/posts/services/unpublished-changes.service";
import { hasUnpublishedChanges } from "@/features/posts/utils/unpublished-changes";
import type {
  CreatePostRevisionInput,
  CreatePostRevisionResult,
  DeletePostRevisionsInput,
  FindPostRevisionByIdInput,
  ListPostRevisionsInput,
  PostRevisionSnapshot,
  RestorePostRevisionInput,
} from "@/features/posts/schema/post-revisions.schema";
import { PostRevisionSnapshotSchema } from "@/features/posts/schema/post-revisions.schema";
import { calculatePostHash } from "@/features/posts/utils/sync";
import { ms } from "@/lib/duration";
import { err, ok } from "@/lib/errors";

const AUTO_SNAPSHOT_MIN_INTERVAL = "2m";
const MAX_AUTO_REVISIONS_PER_POST = 30;

function toRevisionSnapshot(
  post: Awaited<ReturnType<typeof PostRepo.findPostById>>,
): PostRevisionSnapshot {
  if (!post) {
    throw new Error("Expected post to exist when building revision snapshot");
  }

  return {
    title: post.title,
    summary: post.summary,
    slug: post.slug,
    status: post.status,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    contentJson: post.contentJson,
    tagIds: [...new Set(post.tags.map((tag) => tag.id))].sort((a, b) => a - b),
    categoryId: post.categoryId ?? null,
    coverMediaId: post.coverMediaId ?? null,
  };
}

async function hashSnapshot(snapshot: PostRevisionSnapshot) {
  return await calculatePostHash({
    title: snapshot.title,
    contentJson: snapshot.contentJson,
    summary: snapshot.summary,
    tagIds: snapshot.tagIds,
    slug: snapshot.slug,
    publishedAt: snapshot.publishedAt,
    coverMediaId: snapshot.coverMediaId ?? null,
    categoryId: snapshot.categoryId ?? null,
  });
}

export async function listPostRevisions(
  context: DbContext,
  data: ListPostRevisionsInput,
) {
  const revisions = await PostRevisionRepo.listPostRevisions(
    context.db,
    data.postId,
  );
  return revisions.map((revision) => ({
    id: revision.id,
    postId: revision.postId,
    reason: revision.reason,
    snapshotHash: revision.snapshotHash,
    restoredFromRevisionId: revision.restoredFromRevisionId,
    createdAt: revision.createdAt,
    title: revision.snapshotJson.title,
    summary: revision.snapshotJson.summary,
  }));
}

export async function findPostRevisionById(
  context: DbContext,
  data: FindPostRevisionByIdInput,
) {
  return await PostRevisionRepo.findPostRevisionById(
    context.db,
    data.postId,
    data.revisionId,
  );
}

export async function createPostRevision(
  context: DbContext,
  data: CreatePostRevisionInput,
) {
  const reason = data.reason ?? "auto";

  const post = await PostRepo.findPostById(context.db, data.postId);
  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  const snapshot = toRevisionSnapshot(post);
  const snapshotHash = await hashSnapshot(snapshot);

  if (reason === "auto") {
    const [latestRevision, latestAutoRevision] = await Promise.all([
      PostRevisionRepo.findLatestPostRevision(context.db, data.postId),
      PostRevisionRepo.findLatestPostRevision(context.db, data.postId, {
        reason: "auto",
      }),
    ]);

    if (latestRevision?.snapshotHash === snapshotHash) {
      return ok<CreatePostRevisionResult>({
        created: false,
        revision: latestRevision,
        skipReason: "UNCHANGED",
      });
    }

    if (
      latestAutoRevision &&
      Date.now() - latestAutoRevision.createdAt.getTime() <
        ms(AUTO_SNAPSHOT_MIN_INTERVAL)
    ) {
      return ok<CreatePostRevisionResult>({
        created: false,
        revision: latestAutoRevision,
        skipReason: "RATE_LIMITED",
      });
    }
  }

  const revision = await PostRevisionRepo.insertPostRevision(context.db, {
    postId: data.postId,
    reason,
    snapshotJson: snapshot,
    snapshotHash,
  });

  if (reason === "auto") {
    await PostRevisionRepo.trimAutoRevisions(context.db, data.postId, {
      keep: MAX_AUTO_REVISIONS_PER_POST,
    });
  }

  return ok<CreatePostRevisionResult>({
    created: true,
    revision,
  });
}

export async function restorePostRevision(
  context: DbContext & { executionCtx: ExecutionContext },
  data: RestorePostRevisionInput,
) {
  const [post, revision] = await Promise.all([
    PostRepo.findPostById(context.db, data.postId),
    findPostRevisionById(context, data),
  ]);

  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  if (!revision) {
    return err({ reason: "POST_REVISION_NOT_FOUND" });
  }

  const parsedSnapshot = PostRevisionSnapshotSchema.safeParse(
    revision.snapshotJson,
  );
  if (!parsedSnapshot.success) {
    return err({ reason: "POST_REVISION_INVALID_SNAPSHOT" });
  }
  const targetSnapshot = {
    ...parsedSnapshot.data,
    coverMediaId: parsedSnapshot.data.coverMediaId ?? null,
  };
  if (targetSnapshot.coverMediaId != null) {
    const coverMedia = await MediaRepo.findMediaById(
      context.db,
      targetSnapshot.coverMediaId,
    );
    if (!coverMedia) {
      targetSnapshot.coverMediaId = null;
    }
  }

  const currentSnapshot = toRevisionSnapshot(post);
  const [currentHash, targetHash] = await Promise.all([
    hashSnapshot(currentSnapshot),
    hashSnapshot(targetSnapshot),
  ]);

  if (currentHash === targetHash) {
    return ok({
      post,
      restored: false,
      revisionId: revision.id,
    });
  }

  const restoredPost = await PostRevisionRepo.restorePostSnapshot(context.db, {
    postId: data.postId,
    snapshot: targetSnapshot,
    backupRevision: {
      reason: "restore_backup",
      snapshotJson: currentSnapshot,
      snapshotHash: currentHash,
      restoredFromRevisionId: revision.id,
    },
  });

  if (!restoredPost) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  await syncPostMedia(context.db, restoredPost);
  if (restoredPost.publicSnapshotJson) {
    context.executionCtx.waitUntil(
      invalidate.postPublished(context, {
        slug: restoredPost.publicSnapshotJson.slug,
      }),
    );
  }

  return ok({
    post: restoredPost,
    restored: true,
    revisionId: revision.id,
  });
}

/**
 * Makes the draft of a Published Post match what was published again: the
 * latest publish revision, Category and Tags included, is written into it
 * after the draft as it is now is saved as a revision. The public site is not
 * touched. With `saveToken`, a draft saved since that token was read is left
 * as it is and answers EDIT_CONFLICT.
 */
export async function discardUnpublishedChanges(
  context: DbContext,
  data: DiscardPostChangesInput,
) {
  const found = await PostRepo.findPostById(context.db, data.id);
  if (!found) {
    return err({ reason: "POST_NOT_FOUND" });
  }
  if (data.saveToken !== undefined && data.saveToken !== found.saveToken) {
    return err({ reason: "EDIT_CONFLICT", saveToken: found.saveToken });
  }
  if (found.status !== "published") {
    return err({ reason: "POST_NOT_PUBLISHED" });
  }

  const settled = (
    await UnpublishedChangesService.settleFingerprints(context.db, {
      postId: found.id,
    })
  ).get(found.id);
  const post = { ...found, ...settled };
  if (!hasUnpublishedChanges(post)) {
    return err({ reason: "NO_UNPUBLISHED_CHANGES" });
  }

  const [revision] = await PostRevisionRepo.findLatestPublishRevisions(
    context.db,
    [post.id],
  );
  const parsedSnapshot = PostRevisionSnapshotSchema.safeParse(
    revision?.snapshotJson,
  );
  if (!revision || !parsedSnapshot.success) {
    return err({ reason: "POST_REVISION_NOT_FOUND" });
  }
  // Writing the revision must leave the draft as it was published. If the
  // publish did not leave a revision of what it published, this one is not it.
  const publishedFingerprint =
    await UnpublishedChangesService.fingerprintOfRevision(
      parsedSnapshot.data,
      await PostRepo.findAssignableIds(context.db),
    );
  if (publishedFingerprint !== post.publishedFingerprint) {
    return err({ reason: "POST_REVISION_NOT_FOUND" });
  }

  const targetSnapshot = {
    ...parsedSnapshot.data,
    coverMediaId: parsedSnapshot.data.coverMediaId ?? null,
  };
  if (
    targetSnapshot.coverMediaId != null &&
    !(await MediaRepo.findMediaById(context.db, targetSnapshot.coverMediaId))
  ) {
    targetSnapshot.coverMediaId = null;
  }

  const currentSnapshot = toRevisionSnapshot(post);
  const discarded = await PostRevisionRepo.restorePostSnapshot(context.db, {
    postId: post.id,
    snapshot: targetSnapshot,
    backupRevision: {
      reason: "restore_backup",
      snapshotJson: currentSnapshot,
      snapshotHash: await hashSnapshot(currentSnapshot),
      restoredFromRevisionId: revision.id,
    },
    // Without a stated token, still write only the draft that was backed up.
    saveToken: data.saveToken ?? post.saveToken,
  });
  if (!discarded) {
    const saveToken = await PostRepo.findPostSaveToken(context.db, post.id);
    return saveToken === null
      ? err({ reason: "POST_NOT_FOUND" })
      : err({ reason: "EDIT_CONFLICT", saveToken });
  }

  await syncPostMedia(context.db, discarded);
  return ok({ success: true, saveToken: discarded.saveToken });
}

export async function deletePostRevisions(
  context: DbContext,
  data: DeletePostRevisionsInput,
) {
  const deletedRevisions = await PostRevisionRepo.deletePostRevisions(
    context.db,
    data.postId,
    [...new Set(data.revisionIds)],
  );

  return ok({
    deletedIds: deletedRevisions.map((revision) => revision.id),
    deletedCount: deletedRevisions.length,
  });
}
