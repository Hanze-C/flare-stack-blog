import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { CategoriesTable } from "@/lib/db/schema";

const coercedDate = z.union([z.date(), z.string().pipe(z.coerce.date())]);

export const CategorySelectSchema = createSelectSchema(CategoriesTable, {
  createdAt: coercedDate,
});

export const CategoryOptionSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

export const PublicCategorySchema = CategoryOptionSchema;

export const CategoryWithCountSchema = CategorySelectSchema.extend({
  postCount: z.number(),
});

export const AdminCategoryWithCountSchema = CategoryWithCountSchema.extend({
  postCount: z
    .number()
    .describe("How many posts currently have the category, drafts included."),
  publicPostCount: z
    .number()
    .describe(
      "How many published posts show the category on the public site, as of their last publish.",
    ),
});

export const AdminCategoryListSchema = z.object({
  items: z.array(AdminCategoryWithCountSchema),
  uncategorizedPostCount: z
    .number()
    .describe("How many posts currently have no category."),
  uncategorizedPublicPostCount: z
    .number()
    .describe(
      "How many published posts show no category on the public site, as of their last publish.",
    ),
});

export const DeleteCategoryResultSchema = z.object({ success: z.boolean() });

const CategoryNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .describe(
    "Name, trimmed: not empty, at most 50 characters. No other category may have it, ignoring case: that answers 409 CATEGORY_NAME_ALREADY_EXISTS.",
  );

export const CreateCategoryInputSchema = z.strictObject({
  name: CategoryNameInputSchema,
});

export const UpdateCategoryInputSchema = z.strictObject({
  id: z.number(),
  data: z.strictObject({
    name: CategoryNameInputSchema.optional(),
  }),
});

export const DeleteCategoryInputSchema = z.strictObject({
  id: z.number(),
});

export const GetCategoriesInputSchema = z.strictObject({
  sortBy: z.enum(["name", "createdAt", "postCount"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  publicOnly: z.boolean().optional(),
});

export type CreateCategoryInput = z.infer<typeof CreateCategoryInputSchema>;
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;
export type DeleteCategoryInput = z.infer<typeof DeleteCategoryInputSchema>;
export type GetCategoriesInput = z.infer<typeof GetCategoriesInputSchema>;
