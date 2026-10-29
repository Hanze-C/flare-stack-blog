import { z } from "zod";
import {
  AdminFindPostByIdInputSchema,
  AdminPostListPageSchema,
  CreatePostInputSchema,
  DeletePostInputSchema,
  GenerateSlugInputSchema,
  GetPostsInputSchema,
  AdminPostSchema,
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
import * as PostMarkdownService from "@/features/posts/services/post-markdown.service";
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
  CONTENT_FORMAT_AMBIGUOUS: {
    status: 400,
    message: "Send contentJson or contentMarkdown, not both.",
  },
  MARKDOWN_IMAGE_INVALID: {
    status: 400,
    message:
      "Markdown images must be http(s) addresses or Media paths (/images/<key>).",
    data: z.object({
      images: z.array(z.string()).describe("The refused image addresses."),
    }),
  },
} as const;

type MarkdownContentError =
  | { reason: "CONTENT_FORMAT_AMBIGUOUS" }
  | { reason: "MARKDOWN_IMAGE_INVALID"; images: Array<string> };

function throwMarkdownContentError(
  error: MarkdownContentError,
  errors: {
    CONTENT_FORMAT_AMBIGUOUS: () => Error;
    MARKDOWN_IMAGE_INVALID: (options: {
      message: string;
      data: { images: Array<string> };
    }) => Error;
  },
): never {
  switch (error.reason) {
    case "CONTENT_FORMAT_AMBIGUOUS":
      throw errors.CONTENT_FORMAT_AMBIGUOUS();
    case "MARKDOWN_IMAGE_INVALID": {
      const list = error.images.map((src) => `"${src}"`).join(", ");
      throw errors.MARKDOWN_IMAGE_INVALID({
        message: `${error.images.length > 1 ? "Images" : "Image"} ${list} must be an http(s) address or a Media path (/images/<key>). Upload local images as Media and use their path.`,
        data: { images: error.images },
      });
    }
    default:
      error satisfies never;
      throw new Error("Unknown Markdown content error");
  }
}

const adminList = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts",
    summary: "List posts for admin",
    tags: ["Admin Posts"],
  })
  .input(GetPostsInputSchema)
  .output(AdminPostListPageSchema)
  .handler(async ({ context, input }) => {
    const page = await PostService.listAdminPostsPage(context, input);
    return {
      ...page,
      items: await Promise.all(
        page.items.map((item) =>
          PostMarkdownService.inContentFormat(item, input.contentFormat),
        ),
      ),
    };
  });

const adminGet = adminProcedure
  .errors(postErrors)
  .route({
    method: "GET",
    path: "/admin/posts/{id}",
    summary: "Get a post by id",
    description:
      "Returns the editable Post. publicSnapshotContentJson is the Public Content Snapshot body, used to preview published code highlighting in the editor. It is not the draft.",
    tags: ["Admin Posts"],
  })
  .input(AdminFindPostByIdInputSchema)
  .output(AdminPostSchema)
  .handler(async ({ context, input }) => {
    const post = await PostService.findPostById(context, input);
    return (
      post && PostMarkdownService.inContentFormat(post, input.contentFormat)
    );
  });

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
  .errors(postErrors)
  .route({
    method: "POST",
    path: "/admin/posts",
    summary: "Create a draft post",
    description:
      "With data, creates a new draft post carrying that content. Without data, returns an existing empty draft post when one exists, otherwise creates one.",
    tags: ["Admin Posts"],
  })
  .input(CreatePostInputSchema)
  .handler(async ({ context, input, errors }) => {
    if (!input?.data) return PostService.createEmptyPost(context);
    const data = await PostMarkdownService.resolveMarkdownContent(
      context,
      input.data,
    );
    if (data.error) throwMarkdownContentError(data.error, errors);
    return PostService.createDraft(context, data.data);
  });

const update = adminProcedure
  .errors(postErrors)
  .route({
    method: "PATCH",
    path: "/admin/posts/{id}",
    summary: "Update a post",
    tags: ["Admin Posts"],
  })
  .input(UpdatePostInputSchema)
  .handler(async ({ context, input, errors }) => {
    const data = await PostMarkdownService.resolveMarkdownContent(
      context,
      input.data,
      input.id,
    );
    if (data.error) throwMarkdownContentError(data.error, errors);
    return unwrapResult(
      PostService.updatePost(context, { ...input, data: data.data }),
      {
        POST_NOT_FOUND: () => {
          throw errors.POST_NOT_FOUND();
        },
        MEDIA_NOT_FOUND: () => {
          throw errors.MEDIA_NOT_FOUND();
        },
        CATEGORY_NOT_FOUND: () => {
          throw errors.CATEGORY_NOT_FOUND();
        },
      },
    );
  });

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
  .errors(postErrors)
  .route({
    method: "POST",
    path: "/admin/posts/{id}/publish",
    summary: "Publish a post",
    description:
      "Publishes the post and generates or updates its Public Content Snapshot. Code blocks are highlighted on the server and stored in the snapshot.",
    tags: ["Admin Posts"],
  })
  .input(PublishPostInputSchema)
  .handler(async ({ input, errors }) => {
    const result = await (await getPostPublisher(input.id)).publish(input.id);
    return unwrapResult<{ success: boolean }>(result, {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
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
  .handler(async ({ input, errors }) => {
    const result = await (await getPostPublisher(input.id)).unpublish(input.id);
    return unwrapResult<{ success: boolean }>(result, {
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
