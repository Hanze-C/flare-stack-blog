import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  createAdminTestContext,
  createMockExecutionCtx,
  seedAdminApiKey,
  seedUser,
} from "tests/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import * as PostService from "@/features/posts/services/posts.service";
import {
  POST_CONTENT_JSON_LIMIT_BYTES,
  PUBLIC_SNAPSHOT_LIMIT_BYTES,
  serializedBytes,
} from "@/features/posts/utils/post-content-size";
import { unwrap } from "@/lib/errors";
import { PostsTable } from "@/lib/db/schema";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/orpc/body-limit";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

/*
 * A Post's body and snapshot are stored in one D1 row that holds 2,000,000
 * bytes at most. A request under the 2 MiB body limit can still grow past it
 * once it is TipTap JSON, and a snapshot grows again with highlighted code, so
 * the service refuses both with a declared error instead of letting D1 fail.
 */

async function callAdminApi(
  apiKey: string,
  path: string,
  init: { method: string; body: unknown },
) {
  const request = new Request(`http://localhost:3000/api${path}`, {
    method: init.method,
    headers: new Headers({
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(init.body),
  });
  const { response } = await openAPIHandler.handle(request, {
    prefix: "/api",
    context: createApiContext(request.headers, env, createMockExecutionCtx()),
  });
  if (!response) throw new Error(`No route matched ${request.method} ${path}`);
  return response;
}

interface TooLargeBody {
  code: string;
  message: string;
  data: { field: string; limit: number; size: number };
}

/** Markdown that is far smaller than the request limit but not once parsed. */
const OVERSIZED_MARKDOWN = Array.from({ length: 20_000 }, () => "word").join(
  "\n\n",
);

const textDoc = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("Post size limits", () => {
  let adminContext: ReturnType<typeof createAdminTestContext>;

  beforeEach(async () => {
    adminContext = createAdminTestContext({
      executionCtx: createMockExecutionCtx(),
    });
    await seedUser(adminContext.db, adminContext.session.user);
  });

  const savedContent = async (id: number) =>
    (
      await adminContext.db.query.PostsTable.findFirst({
        where: eq(PostsTable.id, id),
      })
    )?.contentJson;

  it("leaves room for a body and a snapshot in one D1 row", () => {
    expect(
      POST_CONTENT_JSON_LIMIT_BYTES + PUBLIC_SNAPSHOT_LIMIT_BYTES,
    ).toBeLessThan(2_000_000);
  });

  describe("a body over the limit after Markdown conversion", () => {
    it("fits the request limit before conversion", () => {
      expect(OVERSIZED_MARKDOWN.length).toBeLessThan(JSON_BODY_LIMIT_BYTES);
    });

    it("refuses a save with 413 POST_CONTENT_TOO_LARGE and writes nothing", async () => {
      const apiKey = await seedAdminApiKey();
      const { id, saveToken } = await PostService.createEmptyPost(adminContext);
      unwrap(
        await PostService.updatePost(adminContext, {
          id,
          data: { title: "Kept", contentJson: textDoc("kept") },
        }),
      );
      const before = await PostService.findPostById(adminContext, { id });

      const response = await callAdminApi(apiKey, `/admin/posts/${id}`, {
        method: "PATCH",
        body: { data: { title: "Lost", contentMarkdown: OVERSIZED_MARKDOWN } },
      });

      expect(response.status).toBe(413);
      const body = (await response.json()) as TooLargeBody;
      expect(body.code).toBe("POST_CONTENT_TOO_LARGE");
      expect(body.data).toMatchObject({
        field: "contentJson",
        limit: POST_CONTENT_JSON_LIMIT_BYTES,
      });
      expect(body.data.size).toBeGreaterThan(POST_CONTENT_JSON_LIMIT_BYTES);
      expect(body.message).toContain(String(POST_CONTENT_JSON_LIMIT_BYTES));

      const after = await PostService.findPostById(adminContext, { id });
      expect(after?.title).toBe("Kept");
      expect(after?.contentJson).toEqual(textDoc("kept"));
      expect(after?.saveToken).toBe(before?.saveToken);
      expect(after?.saveToken).not.toBe(saveToken);
    });

    it("refuses a create and writes no post", async () => {
      const apiKey = await seedAdminApiKey();
      const before = await adminContext.db.query.PostsTable.findMany();

      const response = await callAdminApi(apiKey, "/admin/posts", {
        method: "POST",
        body: {
          data: { title: "Too long", contentMarkdown: OVERSIZED_MARKDOWN },
        },
      });

      expect(response.status).toBe(413);
      expect(((await response.json()) as TooLargeBody).code).toBe(
        "POST_CONTENT_TOO_LARGE",
      );
      expect(await adminContext.db.query.PostsTable.findMany()).toHaveLength(
        before.length,
      );
    });

    it("refuses contentJson over the limit the same way", async () => {
      const { id } = await PostService.createEmptyPost(adminContext);

      const result = await PostService.updatePost(adminContext, {
        id,
        data: { contentJson: textDoc("x".repeat(900_000)) },
      });

      expect(result.error).toMatchObject({
        reason: "POST_CONTENT_TOO_LARGE",
        field: "contentJson",
        limit: POST_CONTENT_JSON_LIMIT_BYTES,
      });
      expect(await savedContent(id)).toBeNull();
    });

    it("keeps a body just under the limit", async () => {
      const { id } = await PostService.createEmptyPost(adminContext);
      const contentJson = textDoc("x".repeat(700_000));
      expect(serializedBytes(contentJson)).toBeLessThan(
        POST_CONTENT_JSON_LIMIT_BYTES,
      );

      unwrap(
        await PostService.updatePost(adminContext, {
          id,
          data: { contentJson },
        }),
      );

      expect(await savedContent(id)).toEqual(contentJson);
    });
  });

  describe("a snapshot over the limit once its code is highlighted", () => {
    // The code is repeated in the draft and again as highlighted HTML.
    const codeDoc = () => ({
      type: "doc" as const,
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 12_000 },
                (_, line) => `let a${line} = ${line};`,
              ).join("\n"),
            },
          ],
        },
      ],
    });

    it("refuses to publish with 413 POST_CONTENT_TOO_LARGE and writes nothing", async () => {
      const { id } = await PostService.createEmptyPost(adminContext);
      const contentJson = codeDoc();
      expect(serializedBytes(contentJson)).toBeLessThan(
        POST_CONTENT_JSON_LIMIT_BYTES,
      );
      unwrap(
        await PostService.updatePost(adminContext, {
          id,
          data: {
            title: "Heavy code",
            slug: "heavy-code",
            publishedAt: new Date(),
            contentJson,
          },
        }),
      );
      const before = await PostService.findPostById(adminContext, { id });

      const result = await PostService.publishPost(adminContext, { id });

      expect(result.error).toMatchObject({
        reason: "POST_CONTENT_TOO_LARGE",
        field: "publicSnapshot",
        limit: PUBLIC_SNAPSHOT_LIMIT_BYTES,
      });
      const row = await adminContext.db.query.PostsTable.findFirst({
        where: eq(PostsTable.id, id),
      });
      expect(row?.status).toBe("draft");
      expect(row?.publicSnapshotJson).toBeNull();
      expect(row?.publicSlug).toBeNull();
      expect(row?.saveToken).toBe(before?.saveToken);
    });

    it("answers the API with 413 and the snapshot field", async () => {
      const apiKey = await seedAdminApiKey();
      const { id } = await PostService.createEmptyPost(adminContext);
      unwrap(
        await PostService.updatePost(adminContext, {
          id,
          data: {
            title: "Heavy code",
            slug: "heavy-code",
            publishedAt: new Date(),
            contentJson: codeDoc(),
          },
        }),
      );

      const response = await callAdminApi(
        apiKey,
        `/admin/posts/${id}/publish`,
        { method: "POST", body: {} },
      );

      expect(response.status).toBe(413);
      const body = (await response.json()) as TooLargeBody;
      expect(body.code).toBe("POST_CONTENT_TOO_LARGE");
      expect(body.data.field).toBe("publicSnapshot");
      expect(body.data.limit).toBe(PUBLIC_SNAPSHOT_LIMIT_BYTES);
    });
  });
});
