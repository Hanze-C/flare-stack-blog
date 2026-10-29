import { z } from "zod";
import {
  AdminPostListPageSchema,
  CreatePostInputSchema,
  DeletePostInputSchema,
  FindPostByIdInputSchema,
  GenerateSlugInputSchema,
  GetPostsInputSchema,
  AdminPostSchema,
  EditConflictDataSchema,
  PostWriteResultSchema,
  PublishPostInputSchema,
  UnpublishPostInputSchema,
  UpdatePostInputSchema,
  VideoMetaInputSchema,
  VideoMetaSchema,
} from "@/features/posts/schema/posts.schema";
import {
  DeletePostRevisionsInputSchema,
  FindPostRevisionByIdInputSchema,
  ListPostRevisionsInputSchema,
  PostRevisionListItemSchema,
  PostRevisionSelectSchema,
  RestorePostRevisionInputSchema,
} from "@/features/posts/schema/post-revisions.schema";
import * as PostRevisionService from "@/features/posts/services/post-revisions.service";
import * as PostService from "@/features/posts/services/posts.service";
import * as VideoMetaService from "@/features/posts/services/video-meta.service";
import { videoSourceOf } from "@/features/posts/utils/video-source";
import { getPostPublisher } from "@/lib/do/post-publisher-binding";
import { adminProcedure } from "@/lib/orpc/procedure";
import { unwrapResult } from "@/lib/orpc/unwrap-result";

const postErrors = {
  POST_NOT_FOUND: { status: 404, message: "Post not found." },
  POST_REVISION_NOT_FOUND: { status: 404, message: "Post revision not found." },
  POST_REVISION_INVALID_SNAPSHOT: {
    status: 400,
    message: "Post revision snapshot is invalid.",
  },
  PUBLISHED_AT_IN_FUTURE: {
    status: 400,
    message: "Publish date cannot be in the future.",
  },
  PUBLIC_SLUG_TAKEN: {
    status: 409,
    message: "This public slug is already in use.",
  },
  MEDIA_NOT_FOUND: { status: 404, message: "Media not found." },
  CATEGORY_NOT_FOUND: { status: 404, message: "Category not found." },
} as const;

const editConflictErrors = {
  EDIT_CONFLICT: {
    status: 409,
    message: "The post was saved since the stated saveToken was read.",
    data: EditConflictDataSchema,
  },
} as const;

const adminList = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts",
    summary: "List posts for admin",
    tags: ["Admin Posts"],
  })
  .input(GetPostsInputSchema)
  .output(AdminPostListPageSchema)
  .handler(({ context, input }) =>
    PostService.listAdminPostsPage(context, input),
  );

const adminGet = adminProcedure
  .errors(postErrors)
  .route({
    method: "GET",
    path: "/admin/posts/{id}",
    summary: "Get a post by id",
    description:
      "Returns the editable Post. publicSnapshotContentJson is the Public Content Snapshot body, used to preview published code highlighting in the editor. It is not the draft. saveToken identifies this read: state it when saving or publishing.",
    tags: ["Admin Posts"],
  })
  .input(FindPostByIdInputSchema)
  .output(AdminPostSchema)
  .handler(({ context, input }) => PostService.findPostById(context, input));

const generateSlug = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts/slug",
    summary: "Generate a post slug",
    tags: ["Admin Posts"],
  })
  .input(GenerateSlugInputSchema)
  .handler(({ context, input }) => PostService.generateSlug(context, input));

const videoMeta = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts/video-meta",
    summary: "Look up an embedded video's title, cover and length",
    description:
      "Asks the video's provider once, when the editor embeds it. Returns null when the provider has nothing to give or cannot be reached.",
    tags: ["Admin Posts"],
  })
  .input(VideoMetaInputSchema)
  .output(VideoMetaSchema)
  .handler(({ input }) => {
    const source = videoSourceOf(input);
    return source ? VideoMetaService.fetchVideoMeta(source) : null;
  });

const create = adminProcedure
  .route({
    method: "POST",
    path: "/admin/posts",
    summary: "Create a draft post",
    description:
      "With data, creates a new draft post carrying that content. Without data, returns an existing empty draft post when one exists, otherwise creates one. Returns the post's id and saveToken.",
    tags: ["Admin Posts"],
  })
  .input(CreatePostInputSchema)
  .handler(({ context, input }) =>
    input?.data
      ? PostService.createDraft(context, input.data)
      : PostService.createEmptyPost(context),
  );

const update = adminProcedure
  .errors({ ...postErrors, ...editConflictErrors })
  .route({
    method: "PATCH",
    path: "/admin/posts/{id}",
    summary: "Update a post",
    description:
      "Writes only the fields in data and returns the updated Post with its new saveToken. With saveToken, the write happens only if the post was not saved since that token was read; otherwise it answers 409 EDIT_CONFLICT, writes nothing, and data.saveToken is the current token.",
    tags: ["Admin Posts"],
  })
  .input(UpdatePostInputSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostService.updatePost(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
      EDIT_CONFLICT: ({ saveToken }) => {
        throw errors.EDIT_CONFLICT({ data: { saveToken } });
      },
      MEDIA_NOT_FOUND: () => {
        throw errors.MEDIA_NOT_FOUND();
      },
      CATEGORY_NOT_FOUND: () => {
        throw errors.CATEGORY_NOT_FOUND();
      },
    }),
  );

const remove = adminProcedure
  .errors(postErrors)
  .route({
    method: "DELETE",
    path: "/admin/posts/{id}",
    summary: "Delete a post",
    tags: ["Admin Posts"],
  })
  .input(DeletePostInputSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostService.deletePost(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
    }),
  );

const publishPost = adminProcedure
  .errors({ ...postErrors, ...editConflictErrors })
  .route({
    method: "POST",
    path: "/admin/posts/{id}/publish",
    summary: "Publish a post",
    description:
      "Publishes the post and generates or updates its Public Content Snapshot. Code blocks are highlighted on the server and stored in the snapshot. With saveToken, only the draft that token was read from is published; if the post was saved since, it answers 409 EDIT_CONFLICT, publishes nothing, and data.saveToken is the current token.",
    tags: ["Admin Posts"],
  })
  .input(PublishPostInputSchema)
  .output(PostWriteResultSchema)
  .handler(async ({ input, errors }) => {
    const result = await (
      await getPostPublisher(input.id)
    ).publish(input.id, input.saveToken);
    return unwrapResult(result, {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
      EDIT_CONFLICT: ({ saveToken }) => {
        throw errors.EDIT_CONFLICT({ data: { saveToken } });
      },
      PUBLISHED_AT_IN_FUTURE: () => {
        throw errors.PUBLISHED_AT_IN_FUTURE();
      },
      PUBLIC_SLUG_TAKEN: () => {
        throw errors.PUBLIC_SLUG_TAKEN();
      },
    });
  });

const unpublishPost = adminProcedure
  .errors(postErrors)
  .route({
    method: "POST",
    path: "/admin/posts/{id}/unpublish",
    summary: "Unpublish a post",
    tags: ["Admin Posts"],
  })
  .input(UnpublishPostInputSchema)
  .output(PostWriteResultSchema)
  .handler(async ({ input, errors }) => {
    const result = await (await getPostPublisher(input.id)).unpublish(input.id);
    return unwrapResult(result, {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
    });
  });

const listRevisions = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts/{postId}/revisions",
    summary: "List post revisions",
    tags: ["Admin Posts"],
  })
  .input(ListPostRevisionsInputSchema)
  .output(z.array(PostRevisionListItemSchema))
  .handler(({ context, input }) =>
    PostRevisionService.listPostRevisions(context, input),
  );

const getRevision = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts/{postId}/revisions/{revisionId}",
    summary: "Get a post revision",
    tags: ["Admin Posts"],
  })
  .input(FindPostRevisionByIdInputSchema)
  .output(PostRevisionSelectSchema.nullable())
  .handler(
    async ({ context, input }) =>
      (await PostRevisionService.findPostRevisionById(context, input)) ?? null,
  );

const restoreRevision = adminProcedure
  .errors(postErrors)
  .route({
    method: "POST",
    path: "/admin/posts/{postId}/revisions/{revisionId}/restore",
    summary: "Restore a post revision",
    description:
      "Writes the revision back into the draft. post.saveToken is the post's token after the restore.",
    tags: ["Admin Posts"],
  })
  .input(RestorePostRevisionInputSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostRevisionService.restorePostRevision(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
      POST_REVISION_NOT_FOUND: () => {
        throw errors.POST_REVISION_NOT_FOUND();
      },
      POST_REVISION_INVALID_SNAPSHOT: () => {
        throw errors.POST_REVISION_INVALID_SNAPSHOT();
      },
    }),
  );

const deleteRevisions = adminProcedure
  .errors(postErrors)
  .route({
    method: "DELETE",
    path: "/admin/posts/{postId}/revisions",
    summary: "Delete post revisions",
    tags: ["Admin Posts"],
  })
  .input(DeletePostRevisionsInputSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostRevisionService.deletePostRevisions(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
    }),
  );

export default {
  list: adminList,
  get: adminGet,
  generateSlug,
  videoMeta,
  create,
  update,
  remove,
  publish: publishPost,
  unpublish: unpublishPost,
  revisions: {
    list: listRevisions,
    get: getRevision,
    restore: restoreRevision,
    remove: deleteRevisions,
  },
};
