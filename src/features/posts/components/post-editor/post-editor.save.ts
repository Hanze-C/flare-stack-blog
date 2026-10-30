import { ORPCError } from "@orpc/client";
import {
  isValidPostSlug,
  isValidPostTitle,
} from "@/features/posts/utils/post-fields";
import { orpcClient } from "@/lib/orpc";
import { persistableTagIds } from "./post-editor.model";
import type { PostEditorSave } from "./types";

/**
 * Writes the editor's post: the post itself stating `saveToken`, then its
 * tags stating the token the update returned. The tags write replaces the
 * token as well, so it cannot run beside the update. A failure between the two
 * keeps the update's token; a newer save by someone else between them refuses
 * the tags with an Edit Conflict like any other save.
 */
export function savePostEdits(postId: number): PostEditorSave {
  return async (data, saveToken, acceptSaveToken) => {
    const updated = await orpcClient.posts.admin.update({
      id: postId,
      saveToken,
      data: {
        // A title or slug the API would refuse, such as an empty one while it
        // is being retyped, stays out so the rest of the post still saves.
        ...(isValidPostTitle(data.title) && { title: data.title }),
        summary: data.summary,
        ...(isValidPostSlug(data.slug) && { slug: data.slug }),
        contentJson: data.contentJson,
        publishedAt: data.publishedAt,
        coverMediaId: data.coverMediaId,
        categoryId: data.categoryId,
      },
    });
    acceptSaveToken(updated.saveToken);
    const tagIds = persistableTagIds(data.tagIds);
    const setTags = (ids: Array<number>) =>
      orpcClient.tags.admin.setPostTags({
        postId,
        tagIds: ids,
        saveToken: updated.saveToken,
      });
    let tagged: { saveToken: string };
    try {
      tagged = await setTags(tagIds);
    } catch (error) {
      if (!(error instanceof ORPCError && error.code === "TAG_NOT_FOUND")) {
        throw error;
      }
      // A tag was deleted since the editor read it. Deleting a tag removes it
      // from every post, so the post keeps the tags that still exist.
      const existing = new Set(
        (await orpcClient.tags.admin.list({})).map((tag) => tag.id),
      );
      tagged = await setTags(tagIds.filter((id) => existing.has(id)));
    }
    acceptSaveToken(tagged.saveToken);
  };
}
