import { orpcClient } from "@/lib/orpc";
import { persistableTagIds } from "./post-editor.model";
import type { PostEditorSave } from "./types";

/**
 * Writes the editor's post: the post itself stating `saveToken`, then its
 * tags. The tags write replaces the token as well, so it cannot run beside
 * the update. A failure between the two keeps the update's token.
 */
export function savePostEdits(postId: number): PostEditorSave {
  return async (data, saveToken, acceptSaveToken) => {
    const updated = await orpcClient.posts.admin.update({
      id: postId,
      saveToken,
      data: {
        title: data.title,
        summary: data.summary,
        slug: data.slug,
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
    });
    if (tagged.saveToken) acceptSaveToken(tagged.saveToken);
  };
}
