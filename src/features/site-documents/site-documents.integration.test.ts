import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  createMockExecutionCtx,
  createTestContext,
  seedAdminApiKey,
} from "tests/test-utils";
import { describe, expect, it } from "vitest";
import {
  buildAtomXml,
  buildFeedJson,
  buildRssXml,
  buildSitemapXml,
} from "@/features/site-documents/service/site-documents.service";
import { PostsTable } from "@/lib/db/schema";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

/**
 * The public documents built from published posts: the sitemap and the three
 * feeds.
 */

async function callAdminApi(
  apiKey: string,
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
) {
  const headers = new Headers({
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  });
  const request = new Request(`http://localhost:3000/api${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const { response } = await openAPIHandler.handle(request, {
    prefix: "/api",
    context: createApiContext(request.headers, env, createMockExecutionCtx()),
  });
  if (!response) throw new Error(`No route matched ${method} ${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { id: number };
}

async function publishedPost(title: string, contentMarkdown: string) {
  const apiKey = await seedAdminApiKey();
  const { id } = await callAdminApi(apiKey, "/admin/posts", {
    data: { title, contentMarkdown },
  });
  await callAdminApi(apiKey, `/admin/posts/${id}/publish`, {});
  return { apiKey, id };
}

async function findPost(id: number) {
  const { db } = createTestContext();
  const post = await db.query.PostsTable.findFirst({
    where: eq(PostsTable.id, id),
  });
  if (!post) throw new Error("Expected the post");
  return { db, post };
}

const lastmodOf = (sitemap: string, slug: string) =>
  new RegExp(
    `<loc>[^<]*/post/${slug}</loc>\\s*<lastmod>([^<]+)</lastmod>`,
  ).exec(sitemap)?.[1];

describe("sitemap", () => {
  it("dates a post by its last publication, not by edits to the draft", async () => {
    const { apiKey, id } = await publishedPost(
      "Sitemap dated post",
      "Published body",
    );
    const { db, post } = await findPost(id);
    const lastPublishedAt = post.publicSnapshotJson?.lastPublishedAt;
    expect(lastPublishedAt).toEqual(expect.any(String));

    // A later edit that nobody published moves the draft's updatedAt.
    await callAdminApi(
      apiKey,
      `/admin/posts/${id}`,
      { data: { contentMarkdown: "An unpublished edit" } },
      "PATCH",
    );
    await db
      .update(PostsTable)
      .set({ updatedAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(PostsTable.id, id));

    const sitemap = await buildSitemapXml(env);
    expect(lastmodOf(sitemap, post.publicSlug ?? "")).toBe(lastPublishedAt);
    expect(sitemap).not.toContain("2030-01-01");
  });

  it("falls back to the publication date for a snapshot without lastPublishedAt", async () => {
    const { id } = await publishedPost("Older snapshot", "Body");
    const { db, post } = await findPost(id);
    if (!post.publicSnapshotJson) throw new Error("Expected a snapshot");
    const { lastPublishedAt: _removed, ...older } = post.publicSnapshotJson;
    await db
      .update(PostsTable)
      .set({
        publicSnapshotJson: {
          ...older,
          publishedAt: "2026-01-02T03:04:05.000Z",
        },
      })
      .where(eq(PostsTable.id, id));

    const sitemap = await buildSitemapXml(env);
    expect(lastmodOf(sitemap, post.publicSlug ?? "")).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
});

describe("feeds", () => {
  it("carry the post body as HTML in JSON Feed, RSS and Atom", async () => {
    await publishedPost(
      "Feed HTML post",
      "Some **bold** text\n\n![pic](/images/pic.png)\n\n- item",
    );
    const executionCtx = createMockExecutionCtx();

    const json = JSON.parse(await buildFeedJson(env, executionCtx)) as {
      items: Array<{ title: string; content_html?: string }>;
    };
    const item = json.items.find((entry) => entry.title === "Feed HTML post");
    expect(item?.content_html).toContain("<strong>bold</strong>");
    expect(item?.content_html).toContain("<li>");
    expect(item?.content_html).toMatch(
      /<img src="https:\/\/[^"]+\/images\/pic\.png"/,
    );

    const rss = await buildRssXml(env, executionCtx);
    expect(rss).toContain("<strong>bold</strong>");
    const atom = await buildAtomXml(env, executionCtx);
    expect(atom).toContain("<strong>bold</strong>");
  });
});
