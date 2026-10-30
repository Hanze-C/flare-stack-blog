import { oo } from "@orpc/openapi";
import { os } from "@orpc/server";
import { z } from "zod";
import {
  ACCEPTED_IMAGE_TYPES,
  DeleteMediaResultSchema,
  DeleteUnusedMediaResultSchema,
  GetMediaListInputSchema,
  ImportMediaUrlInputSchema,
  LinkedPostSchema,
  MAX_FILE_SIZE,
  MediaKeyInputSchema,
  MediaListPageSchema,
  MediaSelectSchema,
  MediaStatsSchema,
  UpdateMediaNameInputSchema,
} from "@/features/media/media.schema";
import * as MediaService from "@/features/media/service/media.service";
import { adminProcedure } from "@/lib/orpc/procedure";
import { unwrapResult } from "@/lib/orpc/unwrap-result";

const mediaErrors = {
  MEDIA_RECORD_CREATE_FAILED: {
    status: 500,
    message: "Failed to create media record.",
  },
  MEDIA_IN_USE: { status: 409, message: "Media is referenced by a post." },
  MEDIA_INVALID: { status: 400, message: "Invalid media upload." },
  MEDIA_NOT_FOUND: { status: 404, message: "Media not found." },
  MEDIA_INVALID_URL: { status: 400, message: "Invalid image URL." },
  MEDIA_IMPORT_FAILED: { status: 400, message: "Could not import image." },
} as const;

const imageFile = z
  .file()
  .max(MAX_FILE_SIZE)
  .mime([...ACCEPTED_IMAGE_TYPES]);

const list = adminProcedure
  .route({
    method: "GET",
    path: "/admin/media",
    summary: "List media",
    tags: ["Admin Media"],
  })
  .input(GetMediaListInputSchema)
  .output(MediaListPageSchema)
  .handler(({ context, input }) => MediaService.getMediaList(context, input));

const upload = adminProcedure
  .errors({
    MEDIA_RECORD_CREATE_FAILED: mediaErrors.MEDIA_RECORD_CREATE_FAILED,
  })
  .route({
    method: "POST",
    path: "/admin/media",
    summary: "Upload an image",
    tags: ["Admin Media"],
  })
  .input(
    z.object({
      image: imageFile,
    }),
  )
  .output(MediaSelectSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(MediaService.upload(context, { file: input.image }), {
      MEDIA_RECORD_CREATE_FAILED: () => {
        throw errors.MEDIA_RECORD_CREATE_FAILED();
      },
    }),
  );

const importFromUrl = adminProcedure
  .errors({
    MEDIA_RECORD_CREATE_FAILED: mediaErrors.MEDIA_RECORD_CREATE_FAILED,
    MEDIA_INVALID_URL: mediaErrors.MEDIA_INVALID_URL,
    MEDIA_IMPORT_FAILED: mediaErrors.MEDIA_IMPORT_FAILED,
    MEDIA_INVALID: mediaErrors.MEDIA_INVALID,
  })
  .route({
    method: "POST",
    path: "/admin/media/import",
    summary: "Import an image from a URL",
    tags: ["Admin Media"],
  })
  .input(ImportMediaUrlInputSchema)
  .output(MediaSelectSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(MediaService.importFromUrl(context, input), {
      MEDIA_RECORD_CREATE_FAILED: () => {
        throw errors.MEDIA_RECORD_CREATE_FAILED();
      },
      MEDIA_INVALID_URL: () => {
        throw errors.MEDIA_INVALID_URL();
      },
      MEDIA_IMPORT_FAILED: () => {
        throw errors.MEDIA_IMPORT_FAILED();
      },
      MEDIA_INVALID: () => {
        throw errors.MEDIA_INVALID();
      },
    }),
  );

const stats = adminProcedure
  .route({
    method: "GET",
    path: "/admin/media/stats",
    summary: "Get media library stats",
    tags: ["Admin Media"],
  })
  .output(MediaStatsSchema)
  .handler(({ context }) => MediaService.getMediaStats(context));

const totalSize = adminProcedure
  .route({
    method: "GET",
    path: "/admin/media/size",
    summary: "Get total media size",
    tags: ["Admin Media"],
  })
  .output(z.number().int())
  .handler(({ context }) => MediaService.getTotalMediaSize(context));

const linkedKeys = adminProcedure
  .route({
    method: "POST",
    path: "/admin/media/linked-keys",
    summary: "Resolve which media keys are linked",
    tags: ["Admin Media"],
  })
  .input(z.object({ keys: z.array(z.string()) }))
  .output(z.array(z.string()))
  .handler(({ context, input }) =>
    MediaService.getLinkedMediaKeys(context, input.keys),
  );

const removeUnused = adminProcedure
  .route({
    method: "DELETE",
    path: "/admin/media/unused",
    summary: "Delete unused media",
    tags: ["Admin Media"],
  })
  .output(DeleteUnusedMediaResultSchema)
  .handler(async ({ context }) => {
    const result = await MediaService.deleteUnused(context);
    if (result.data === null) throw new Error("Expected ok result");
    return result;
  });

const remove = adminProcedure
  .errors({ MEDIA_IN_USE: mediaErrors.MEDIA_IN_USE })
  .route({
    method: "DELETE",
    path: "/admin/media/{key}",
    summary: "Delete media",
    tags: ["Admin Media"],
  })
  .input(MediaKeyInputSchema)
  .output(DeleteMediaResultSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(MediaService.deleteImage(context, input.key.trim()), {
      MEDIA_IN_USE: () => {
        throw errors.MEDIA_IN_USE();
      },
    }),
  );

const linkedPosts = adminProcedure
  .route({
    method: "GET",
    path: "/admin/media/{key}/posts",
    summary: "List posts linked to media",
    tags: ["Admin Media"],
  })
  .input(MediaKeyInputSchema)
  .output(z.array(LinkedPostSchema))
  .handler(({ context, input }) =>
    MediaService.getLinkedPosts(context, input.key.trim()),
  );

const replace = adminProcedure
  .errors({ MEDIA_NOT_FOUND: mediaErrors.MEDIA_NOT_FOUND })
  .route({
    method: "POST",
    path: "/admin/media/{key}/replace",
    summary: "Replace media file",
    tags: ["Admin Media"],
  })
  .input(
    z.object({
      key: z.string(),
      image: imageFile,
    }),
  )
  .output(MediaSelectSchema)
  .handler(({ context, input, errors }) =>
    unwrapResult(
      MediaService.replaceImage(context, {
        key: input.key.trim(),
        file: input.image,
      }),
      {
        MEDIA_NOT_FOUND: () => {
          throw errors.MEDIA_NOT_FOUND();
        },
      },
    ),
  );

// The rename answers 200 with an empty body, which a response schema cannot
// say: the document describes the response without a body instead.
const emptyResponse = oo.spec(
  os.middleware(({ next }) => next()),
  (operation) => ({
    ...operation,
    responses: {
      ...operation.responses,
      200: { description: "Renamed. The response body is empty." },
    },
  }),
);

const updateName = adminProcedure
  .use(emptyResponse)
  .route({
    method: "PATCH",
    path: "/admin/media/{key}",
    summary: "Rename media",
    tags: ["Admin Media"],
  })
  .input(UpdateMediaNameInputSchema)
  .output(z.void())
  .handler(({ context, input }) =>
    MediaService.updateMediaName(context, input),
  );

export default {
  list,
  upload,
  importFromUrl,
  stats,
  totalSize,
  linkedKeys,
  removeUnused,
  remove,
  linkedPosts,
  replace,
  updateName,
};
