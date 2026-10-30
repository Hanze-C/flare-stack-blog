import { z } from "zod";
import {
  AdminFindPostByIdInputSchema,
  AdminPostListPageSchema,
  CreatePostInputSchema,
  CreatePostResultSchema,
  DeletePostInputSchema,
  DeletePostResultSchema,
  DeletePostRevisionsResultSchema,
  DiscardPostChangesInputSchema,
  GenerateSlugInputSchema,
  GenerateSlugResultSchema,
  GetPostsInputSchema,
  PinPostInputSchema,
  AdminPostSchema,
  EditConflictDataSchema,
  PostWriteResultSchema,
  PublishPostInputSchema,
  RestorePostRevisionResultSchema,
  UnpinPostInputSchema,
  UnpublishPostInputSchema,
  UpdatedPostSchema,
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

// Every error a post operation can answer. Each operation declares only the
// ones its service or handler really returns, picked from here.
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
  SLUG_TAKEN: {
    status: 409,
    message:
      "Another post already uses this slug, or a case variant of it, as its slug or live page.",
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

const markdownContentErrors = {
  CONTENT_FORMAT_AMBIGUOUS: postErrors.CONTENT_FORMAT_AMBIGUOUS,
  MARKDOWN_IMAGE_INVALID: postErrors.MARKDOWN_IMAGE_INVALID,
} as const;

const postNotFoundErrors = {
  POST_NOT_FOUND: postErrors.POST_NOT_FOUND,
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

const editConflictErrors = {
  EDIT_CONFLICT: {
    status: 409,
    message: "The post was saved since the stated saveToken was read.",
    data: EditConflictDataSchema,
  },
} as const;

const discardChangesErrors = {
  POST_NOT_PUBLISHED: {
    status: 409,
    message: "The post is not published, so there is nothing to discard to.",
  },
  NO_UNPUBLISHED_CHANGES: {
    status: 409,
    message: "The draft already matches the published version.",
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
  .errors(postNotFoundErrors)
  .route({
    method: "GET",
    path: "/admin/posts/{id}",
    summary: "Get a post by id",
    description:
      "Returns the editable Post, or answers 404 POST_NOT_FOUND when there is none. hasUnpublishedChanges tells whether the draft differs from the published version. publicSnapshotContentJson is the Public Content Snapshot body, used to preview published code highlighting in the editor. It is not the draft. saveToken identifies this read: state it when saving or publishing.",
    tags: ["Admin Posts"],
  })
  .input(AdminFindPostByIdInputSchema)
  .output(AdminPostSchema)
  .handler(async ({ context, input, errors }) => {
    const post = await PostService.findPostById(context, input);
    if (!post) throw errors.POST_NOT_FOUND();
    return PostMarkdownService.inContentFormat(post, input.contentFormat);
  });

const generateSlug = adminProcedure
  .route({
    method: "GET",
    path: "/admin/posts/slug",
    summary: "Generate a post slug",
    tags: ["Admin Posts"],
  })
  .input(GenerateSlugInputSchema)
  .output(GenerateSlugResultSchema)
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
  .errors(markdownContentErrors)
  .route({
    method: "POST",
    path: "/admin/posts",
    summary: "Create a draft post",
    description:
      "With data, creates a new draft post carrying that content. Without data, returns an existing empty draft post when one exists, otherwise creates one. Returns the post's id and saveToken, never the body, so it takes no contentFormat; read the post to get it in either format.",
    tags: ["Admin Posts"],
  })
  .input(CreatePostInputSchema)
  .output(CreatePostResultSchema)
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
  .errors({
    ...postNotFoundErrors,
    ...markdownContentErrors,
    MEDIA_NOT_FOUND: postErrors.MEDIA_NOT_FOUND,
    CATEGORY_NOT_FOUND: postErrors.CATEGORY_NOT_FOUND,
    SLUG_TAKEN: postErrors.SLUG_TAKEN,
    ...editConflictErrors,
  })
  .route({
    method: "PATCH",
    path: "/admin/posts/{id}",
    summary: "Update a post",
    description:
      "Writes only the fields in data and returns the updated Post with its new saveToken. The body comes back as contentJson, or as contentMarkdown instead when contentFormat=markdown (a top-level field next to data), whichever format it was written in. With saveToken, the write happens only if the post was not saved since that token was read; otherwise it answers 409 EDIT_CONFLICT, writes nothing, and data.saveToken is the current token.",
    tags: ["Admin Posts"],
  })
  .input(UpdatePostInputSchema)
  .output(UpdatedPostSchema)
  .handler(async ({ context, input, errors }) => {
    const data = await PostMarkdownService.resolveMarkdownContent(
      context,
      input.data,
      input.id,
    );
    if (data.error) throwMarkdownContentError(data.error, errors);
    const { contentFormat, ...write } = input;
    const post = await unwrapResult(
      PostService.updatePost(context, { ...write, data: data.data }),
      {
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
        SLUG_TAKEN: () => {
          throw errors.SLUG_TAKEN();
        },
      },
    );
    return PostMarkdownService.inContentFormat(post, contentFormat);
  });

const remove = adminProcedure
  .errors(postNotFoundErrors)
  .route({
    method: "DELETE",
    path: "/admin/posts/{id}",
    summary: "Delete a post",
    tags: ["Admin Posts"],
  })
  .input(DeletePostInputSchema)
  .output(DeletePostResultSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostService.deletePost(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
    }),
  );

const publishPost = adminProcedure
  .errors({
    ...postNotFoundErrors,
    PUBLISHED_AT_IN_FUTURE: postErrors.PUBLISHED_AT_IN_FUTURE,
    PUBLIC_SLUG_TAKEN: postErrors.PUBLIC_SLUG_TAKEN,
    ...editConflictErrors,
  })
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
  .errors(postNotFoundErrors)
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

const discardChanges = adminProcedure
  .errors({
    ...postNotFoundErrors,
    POST_REVISION_NOT_FOUND: postErrors.POST_REVISION_NOT_FOUND,
    ...discardChangesErrors,
    ...editConflictErrors,
  })
  .route({
    method: "POST",
    path: "/admin/posts/{id}/discard-changes",
    summary: "Discard a post's unpublished changes",
    description:
      "Makes the draft of a published post that has unpublished changes (hasUnpublishedChanges) match the published version again: title, summary, slug, body, publication date, cover, category and tags. The draft as it is now is first saved as a Post Revision, so the discarded changes can be restored from the revision list. The published page is not touched. Answers 409 POST_NOT_PUBLISHED for a draft post and 409 NO_UNPUBLISHED_CHANGES when the draft already matches. With saveToken, only the draft that token was read from is discarded; if the post was saved since, it answers 409 EDIT_CONFLICT, writes nothing, and data.saveToken is the current token. Returns the post's new saveToken.",
    tags: ["Admin Posts"],
  })
  .input(DiscardPostChangesInputSchema)
  .output(PostWriteResultSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(
      PostRevisionService.discardUnpublishedChanges(context, input),
      {
        POST_NOT_FOUND: () => {
          throw errors.POST_NOT_FOUND();
        },
        POST_REVISION_NOT_FOUND: () => {
          throw errors.POST_REVISION_NOT_FOUND();
        },
        POST_NOT_PUBLISHED: () => {
          throw errors.POST_NOT_PUBLISHED();
        },
        NO_UNPUBLISHED_CHANGES: () => {
          throw errors.NO_UNPUBLISHED_CHANGES();
        },
        EDIT_CONFLICT: ({ saveToken }) => {
          throw errors.EDIT_CONFLICT({ data: { saveToken } });
        },
      },
    ),
  );

const pinPost = adminProcedure
  .errors(postNotFoundErrors)
  .route({
    method: "POST",
    path: "/admin/posts/{id}/pin",
    summary: "Pin a post",
    description:
      "Pins the post to the top of the homepage. Takes effect at once, without publishing: the public site reads the post's own pin, not the Public Content Snapshot, and its caches are purged. Pinning an already pinned post keeps its place. A draft can be pinned too; the pin shows once it is published. The pin is not part of the draft, so the post's saveToken stays as it was.",
    tags: ["Admin Posts"],
  })
  .input(PinPostInputSchema)
  .output(PostWriteResultSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostService.pinPost(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
    }),
  );

const unpinPost = adminProcedure
  .errors(postNotFoundErrors)
  .route({
    method: "POST",
    path: "/admin/posts/{id}/unpin",
    summary: "Unpin a post",
    description:
      "Removes the post's pin. Takes effect at once, without publishing, and purges the public caches. The pin is not part of the draft, so the post's saveToken stays as it was.",
    tags: ["Admin Posts"],
  })
  .input(UnpinPostInputSchema)
  .output(PostWriteResultSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(PostService.unpinPost(context, input), {
      POST_NOT_FOUND: () => {
        throw errors.POST_NOT_FOUND();
      },
    }),
  );

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
  .errors({ POST_REVISION_NOT_FOUND: postErrors.POST_REVISION_NOT_FOUND })
  .route({
    method: "GET",
    path: "/admin/posts/{postId}/revisions/{revisionId}",
    summary: "Get a post revision",
    description:
      "Answers 404 POST_REVISION_NOT_FOUND when the post has no such revision.",
    tags: ["Admin Posts"],
  })
  .input(FindPostRevisionByIdInputSchema)
  .output(PostRevisionSelectSchema)
  .handler(async ({ context, input, errors }) => {
    const revision = await PostRevisionService.findPostRevisionById(
      context,
      input,
    );
    if (!revision) throw errors.POST_REVISION_NOT_FOUND();
    return revision;
  });

const restoreRevision = adminProcedure
  .errors({
    ...postNotFoundErrors,
    POST_REVISION_NOT_FOUND: postErrors.POST_REVISION_NOT_FOUND,
    POST_REVISION_INVALID_SNAPSHOT: postErrors.POST_REVISION_INVALID_SNAPSHOT,
  })
  .route({
    method: "POST",
    path: "/admin/posts/{postId}/revisions/{revisionId}/restore",
    summary: "Restore a post revision",
    description:
      "Writes the revision back into the draft. post.saveToken is the post's token after the restore.",
    tags: ["Admin Posts"],
  })
  .input(RestorePostRevisionInputSchema)
  .output(RestorePostRevisionResultSchema)
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
  .route({
    method: "DELETE",
    path: "/admin/posts/{postId}/revisions",
    summary: "Delete post revisions",
    tags: ["Admin Posts"],
  })
  .input(DeletePostRevisionsInputSchema)
  .output(DeletePostRevisionsResultSchema)
  .handler(({ context, input }) =>
    unwrapResult(PostRevisionService.deletePostRevisions(context, input), {}),
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
  discardChanges,
  pin: pinPost,
  unpin: unpinPost,
  revisions: {
    list: listRevisions,
    get: getRevision,
    restore: restoreRevision,
    remove: deleteRevisions,
  },
};
