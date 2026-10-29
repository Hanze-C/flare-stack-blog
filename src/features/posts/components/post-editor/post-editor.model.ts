import { ORPCError } from "@orpc/client";
import type { JSONContent } from "@tiptap/react";
import type { EditConflict } from "./types";

const CJK_CHAR =
  /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;

export const BLOB_UPLOADING_ERROR = "BLOB_UPLOADING";
/** What `flush` throws once a save was refused; the conflict notice is shown. */
export const EDIT_CONFLICT_ERROR = "EDIT_CONFLICT";

/** The conflict a failed write was refused with, if it was an Edit Conflict. */
export function editConflictOf(error: unknown): EditConflict | null {
  if (!(error instanceof ORPCError) || error.code !== "EDIT_CONFLICT") {
    return null;
  }
  const data: unknown = error.data;
  if (
    data &&
    typeof data === "object" &&
    "saveToken" in data &&
    typeof data.saveToken === "string"
  ) {
    return { saveToken: data.saveToken };
  }
  return null;
}

export function persistableTagIds(tagIds: Array<number>) {
  return tagIds.filter((id) => id > 0);
}

export function contentHasBlobUrl(
  doc: JSONContent | null | undefined,
): boolean {
  if (!doc) return false;
  if (
    doc.type === "image" &&
    typeof doc.attrs?.src === "string" &&
    doc.attrs.src.startsWith("blob:")
  ) {
    return true;
  }
  return doc.content?.some((node) => contentHasBlobUrl(node)) ?? false;
}

export function contentStatsFromText(text: string) {
  const chars = text.replace(/\n/g, "").length;
  const cjkChars = (text.match(CJK_CHAR) || []).length;
  const textWithoutCjk = text.replace(CJK_CHAR, " ");
  const englishWords = textWithoutCjk.split(/\s+/).filter(Boolean).length;
  return { chars, words: cjkChars + englishWords };
}

// New drafts are created as `untitled-log`, `untitled-log-N`, or with a random
// suffix after a contended insert.
const PLACEHOLDER_SLUG = /^untitled-log(?:-[a-z0-9]+)*$/;

/**
 * Whether a title change should regenerate the slug. A published post keeps
 * its slug, since there is no redirect from an old public slug.
 */
export function shouldAutogenerateSlug(
  slug: string,
  lastAutoSlug: string | null,
  published = false,
) {
  if (published) return false;
  const trimmed = slug.trim();
  return (
    trimmed.length === 0 ||
    PLACEHOLDER_SLUG.test(trimmed) ||
    lastAutoSlug === trimmed
  );
}
