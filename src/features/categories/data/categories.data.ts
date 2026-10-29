import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { CategoriesTable, PostsTable } from "@/lib/db/schema";

export async function insertCategory(
  db: DB,
  data: typeof CategoriesTable.$inferInsert,
) {
  const [category] = await db.insert(CategoriesTable).values(data).returning();
  return category;
}

export async function findCategoryById(db: DB, id: number) {
  return await db.query.CategoriesTable.findFirst({
    where: eq(CategoriesTable.id, id),
  });
}

export async function nameExists(
  db: DB,
  name: string,
  options: { excludeId?: number } = {},
) {
  const conditions = [eq(CategoriesTable.name, name)];
  if (options.excludeId != null) {
    conditions.push(ne(CategoriesTable.id, options.excludeId));
  }
  const row = await db.query.CategoriesTable.findFirst({
    where: and(...conditions),
  });
  return !!row;
}

export async function getAllCategoriesWithCount(
  db: DB,
  options: {
    sortBy?: "name" | "createdAt" | "postCount";
    sortDir?: "asc" | "desc";
    publicOnly?: boolean;
  } = {},
) {
  const { sortBy = "name", sortDir = "asc", publicOnly = false } = options;
  const orderFn = sortDir === "asc" ? asc : desc;

  const query = db
    .select({
      id: CategoriesTable.id,
      name: CategoriesTable.name,
      createdAt: CategoriesTable.createdAt,
      postCount: count(PostsTable.id).as("postCount"),
    })
    .from(CategoriesTable)
    // Public Usage counts the public assignments, Current Assignment the draft's.
    .leftJoin(
      PostsTable,
      eq(
        publicOnly ? PostsTable.publicCategoryId : PostsTable.categoryId,
        CategoriesTable.id,
      ),
    )
    .where(publicOnly ? isNotNull(PostsTable.publicSnapshotJson) : undefined)
    .groupBy(CategoriesTable.id)
    .$dynamic();

  if (sortBy === "postCount") {
    query.orderBy(orderFn(sql`postCount`));
  } else if (sortBy === "createdAt") {
    query.orderBy(orderFn(CategoriesTable.createdAt));
  } else {
    query.orderBy(orderFn(CategoriesTable.name));
  }

  return await query;
}

export async function countUncategorizedPosts(db: DB, publicOnly = false) {
  const [row] = await db
    .select({ postCount: count() })
    .from(PostsTable)
    .where(
      publicOnly
        ? and(
            isNotNull(PostsTable.publicSnapshotJson),
            isNull(PostsTable.publicCategoryId),
          )
        : isNull(PostsTable.categoryId),
    );
  return Number(row?.postCount ?? 0);
}

export async function updateCategory(
  db: DB,
  id: number,
  data: { name?: string },
) {
  const [category] = await db
    .update(CategoriesTable)
    .set(data)
    .where(eq(CategoriesTable.id, id))
    .returning();
  return category;
}

export async function deleteCategory(db: DB, id: number) {
  // Clear the Posts' category here rather than leave it to ON DELETE SET NULL,
  // so the write replaces their saveToken like any other. Their public
  // Category is left to ON DELETE SET NULL: it is not part of the draft.
  await db.batch([
    db
      .update(PostsTable)
      .set({
        categoryId: null,
        // Their Unpublished Changes are decided again without the Category.
        draftFingerprint: null,
        publishedFingerprint: null,
        updatedAt: sql`${PostsTable.updatedAt}`,
      })
      .where(eq(PostsTable.categoryId, id)),
    // A Post that shows the Category publicly loses it there too, which
    // changes what it was published with, even if its draft has moved on.
    db
      .update(PostsTable)
      .set({
        draftFingerprint: null,
        publishedFingerprint: null,
        updatedAt: sql`${PostsTable.updatedAt}`,
      })
      .where(eq(PostsTable.publicCategoryId, id)),
    db.delete(CategoriesTable).where(eq(CategoriesTable.id, id)),
  ]);
}

/** Published Posts that publicly show the Category (its Public Usage). */
export async function getPublishedPostsByCategoryId(
  db: DB,
  categoryId: number,
) {
  return await db
    .select({
      id: PostsTable.id,
      slug: PostsTable.publicSlug,
    })
    .from(PostsTable)
    .where(
      and(
        isNotNull(PostsTable.publicSnapshotJson),
        eq(PostsTable.publicCategoryId, categoryId),
      ),
    );
}
