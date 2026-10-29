import type { JSONContent } from "@tiptap/react";
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, updatedAt } from "./helper";

export const POST_STATUSES = ["draft", "published"] as const;

export type PublicPostCover = {
  mediaId: number;
  key: string;
  url: string;
  width: number | null;
  height: number | null;
};

export type PublicPostSnapshot = {
  title: string;
  summary: string | null;
  slug: string;
  contentJson: JSONContent | null;
  // Written with the public assignments below (ADR 0033); public reads, filters
  // and counts use those relations rather than these ids.
  tagIds: Array<number>;
  categoryId: number | null;
  publishedAt: string;
  // Snapshots written before pinning left the snapshot may still carry a
  // pinnedAt; nothing reads it.
  cover: PublicPostCover | null;
};

export function newSaveToken() {
  return crypto.randomUUID();
}

export const CategoriesTable = sqliteTable("categories", {
  id,
  name: text().notNull().unique(),
  createdAt,
});

export const PostsTable = sqliteTable(
  "posts",
  {
    id,
    title: text().notNull(),
    summary: text(),
    slug: text().notNull().unique(),

    contentJson: text("content_json", { mode: "json" }).$type<JSONContent>(),
    publicSnapshotJson: text("public_snapshot_json", {
      mode: "json",
    }).$type<PublicPostSnapshot>(),
    publicSlug: text("public_slug"),
    status: text("status", { enum: POST_STATUSES }).notNull().default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    pinnedAt: integer("pinned_at", { mode: "timestamp" }),
    coverMediaId: integer("cover_media_id"),
    categoryId: integer("category_id").references(() => CategoriesTable.id, {
      onDelete: "set null",
    }),
    // The Category the Public Content Snapshot assigns, written with it on
    // publish and cleared on unpublish (ADR 0033).
    publicCategoryId: integer("public_category_id").references(
      () => CategoriesTable.id,
      { onDelete: "set null" },
    ),
    // Opaque, replaced by every write to the row so a save can refuse an
    // Edit Conflict (ADR 0031). $onUpdate covers every Drizzle update;
    // pinning keeps it, since the pin is not part of the draft.
    saveToken: text("save_token")
      .notNull()
      .$defaultFn(newSaveToken)
      .$onUpdate(newSaveToken),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("posts_public_slug_unique").on(table.publicSlug),
    index("published_at_idx").on(table.publishedAt, table.status),
    index("created_at_idx").on(table.createdAt),
    index("posts_cover_media_id_idx").on(table.coverMediaId),
    index("posts_category_id_idx").on(table.categoryId),
    index("posts_public_category_id_idx").on(table.publicCategoryId),
  ],
);

export const TagsTable = sqliteTable("tags", {
  id,
  name: text().notNull().unique(),
  createdAt,
});

export const PostTagsTable = sqliteTable(
  "post_tags",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => PostsTable.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => TagsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.tagId] }),
    index("post_tags_tag_idx").on(table.tagId),
  ],
);

/**
 * The Tags the Public Content Snapshot assigns, written with it on publish and
 * cleared on unpublish (ADR 0033). `post_tags` holds the draft's.
 */
export const PostPublicTagsTable = sqliteTable(
  "post_public_tags",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => PostsTable.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => TagsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.tagId] }),
    index("post_public_tags_tag_idx").on(table.tagId),
  ],
);

// ==================== relations ====================
export const postsRelations = relations(PostsTable, ({ many, one }) => ({
  postTags: many(PostTagsTable),
  category: one(CategoriesTable, {
    fields: [PostsTable.categoryId],
    references: [CategoriesTable.id],
  }),
}));

export const categoriesRelations = relations(CategoriesTable, ({ many }) => ({
  posts: many(PostsTable),
}));

export const tagsRelations = relations(TagsTable, ({ many }) => ({
  postTags: many(PostTagsTable),
}));

export const postTagsRelations = relations(PostTagsTable, ({ one }) => ({
  post: one(PostsTable, {
    fields: [PostTagsTable.postId],
    references: [PostsTable.id],
  }),
  tag: one(TagsTable, {
    fields: [PostTagsTable.tagId],
    references: [TagsTable.id],
  }),
}));

// ==================== types ====================
export type Tag = typeof TagsTable.$inferSelect;
export type Category = typeof CategoriesTable.$inferSelect;
export type Post = typeof PostsTable.$inferSelect;
export type PostStatus = (typeof POST_STATUSES)[number];
