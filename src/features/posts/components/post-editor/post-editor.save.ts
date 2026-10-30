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
    const tagged = await orpcClient.tags.admin.setPostTags({
      postId,
      tagIds: persistableTagIds(data.tagIds),
      saveToken: updated.saveToken,
    });
    acceptSaveToken(tagged.saveToken);
  };
}
