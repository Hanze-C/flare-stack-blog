import {
  normalizePostCategoryName,
  normalizePostTagName,
} from "@/features/posts/schema/posts.schema";

export type PostsPublicSearch = {
  tagName?: string;
  categoryName?: string;
  uncategorized?: boolean;
};

export function withTagFilter(tagName: string | undefined): PostsPublicSearch {
  const name = normalizePostTagName(tagName);
  return name ? { tagName: name } : {};
}

export function withCategoryFilter(
  categoryName: string | undefined,
): PostsPublicSearch {
  const name = normalizePostCategoryName(categoryName);
  return name ? { categoryName: name } : {};
}

export function withUncategorizedFilter(): PostsPublicSearch {
  return { uncategorized: true };
}

/**
 * The name a public page is addressed by, as the Tag or Category spells it:
 * an exact match first, else one that differs only in case. `null` when no
 * name matches, which is a page that does not exist. `undefined` stays
 * `undefined`: no filter.
 */
export function resolvePublicName(
  names: ReadonlyArray<string>,
  requested: string | undefined,
): string | null | undefined {
  if (requested === undefined) return undefined;
  if (names.includes(requested)) return requested;
  const lowered = requested.toLowerCase();
  return names.find((name) => name.toLowerCase() === lowered) ?? null;
}
