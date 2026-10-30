import { env } from "cloudflare:workers";
import { createMockExecutionCtx, seedAdminApiKey } from "tests/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchVideoMeta } from "@/features/posts/services/video-meta.service";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

/**
 * Post content exchanged as Markdown over the Admin HTTP API (ADR 0032), the
 * way an agent or external editor calls it with an API Key.
 */

vi.mock("@/features/posts/services/video-meta.service", () => ({
  fetchVideoMeta: vi.fn(),
}));

const lookUpVideo = vi.mocked(fetchVideoMeta);

const BILIBILI_LINK = "https://www.bilibili.com/video/BV1fK4y1s7Qf/?p=2&t=90";
const BILIBILI_META = {
  title: "A Bilibili video",
  cover: "https://i0.hdslb.com/bfs/archive/cover.jpg",
  duration: 321,
};

const paragraph = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function callAdminApi(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const headers = new Headers({ "x-api-key": apiKey });
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }
  const request = new Request(`http://localhost:3000/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });
  const { response } = await openAPIHandler.handle(request, {
    prefix: "/api",
    context: createApiContext(request.headers, env, createMockExecutionCtx()),
  });
  if (!response) throw new Error(`No route matched ${request.method} ${path}`);
  return response;
}

async function createPost(apiKey: string, data: Record<string, unknown>) {
  const response = await callAdminApi(apiKey, "/admin/posts", {
    method: "POST",
    body: { data: { title: "Markdown post", ...data } },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: number }).id;
}

interface ReadPost {
  contentJson?: { content?: Array<{ type: string; attrs?: object }> } | null;
  contentMarkdown?: string | null;
}

async function readPost(apiKey: string, id: number, query = "") {
  const response = await callAdminApi(apiKey, `/admin/posts/${id}${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ReadPost;
}

beforeEach(() => {
  lookUpVideo.mockReset();
  lookUpVideo.mockResolvedValue(null);
});

describe("Post content as Markdown over the Admin API", () => {
  it("writes Markdown and reads it back in either format", async () => {
    const apiKey = await seedAdminApiKey();
    const markdown = [
      "## Intro",
      "Some **bold** text and $x^2$.",
      "| A | B |\n| :-- | --: |\n| 1 | 2 |",
      "```mermaid\nflowchart LR\n  A --> B\n```",
      "![cover](/images/cover.png)",
    ].join("\n\n");

    const id = await createPost(apiKey, { contentMarkdown: markdown });

    const asJson = await readPost(apiKey, id);
    expect(asJson.contentMarkdown).toBeUndefined();
    expect(asJson.contentJson?.content?.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      "codeBlock",
      "image",
    ]);

    const asMarkdown = await readPost(apiKey, id, "?contentFormat=markdown");
    expect(asMarkdown).not.toHaveProperty("contentJson");
    expect(asMarkdown.contentMarkdown).toContain("## Intro");
    expect(asMarkdown.contentMarkdown).toContain("$x^2$");
    expect(asMarkdown.contentMarkdown).toContain("```mermaid");
    expect(asMarkdown.contentMarkdown).toContain("![cover](/images/cover.png)");

    // Writing back what was read changes nothing.
    const patch = await callAdminApi(apiKey, `/admin/posts/${id}`, {
      method: "PATCH",
      body: { data: { contentMarkdown: asMarkdown.contentMarkdown } },
    });
    expect(patch.status).toBe(200);
    expect((await readPost(apiKey, id)).contentJson).toEqual(
      asJson.contentJson,
    );
  });

  it("answers a PATCH in the requested content format", async () => {
    const apiKey = await seedAdminApiKey();
    const id = await createPost(apiKey, { contentJson: paragraph("Before") });

    const asMarkdown = await callAdminApi(apiKey, `/admin/posts/${id}`, {
      method: "PATCH",
      body: {
        data: { contentMarkdown: "## Heading\n\nWritten **bold**" },
        contentFormat: "markdown",
      },
    });
    expect(asMarkdown.status).toBe(200);
    const written = (await asMarkdown.json()) as ReadPost & {
      saveToken: string;
    };
    expect(written).not.toHaveProperty("contentJson");
    expect(written.contentMarkdown).toContain("## Heading");
    expect(written.contentMarkdown).toContain("**bold**");
    expect(written.saveToken).toEqual(expect.any(String));

    const asJson = await callAdminApi(apiKey, `/admin/posts/${id}`, {
      method: "PATCH",
      body: { data: { title: "Renamed" } },
    });
    expect(asJson.status).toBe(200);
    const plain = (await asJson.json()) as ReadPost;
    expect(plain).not.toHaveProperty("contentMarkdown");
    expect(plain.contentJson?.content?.[0]?.type).toBe("heading");
  });

  it("reads Markdown in the list with includeContent", async () => {
    const apiKey = await seedAdminApiKey();
    const id = await createPost(apiKey, { contentJson: paragraph("Listed") });
    const empty = await createPost(apiKey, { contentJson: null });

    const response = await callAdminApi(
      apiKey,
      "/admin/posts?includeContent=true&contentFormat=markdown&sortBy=id&sortDir=ASC",
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      items: Array<{ id: number } & ReadPost>;
    };
    const items = new Map(page.items.map((item) => [item.id, item]));
    expect(items.get(id)?.contentMarkdown).toBe("Listed\n");
    expect(items.get(empty)?.contentMarkdown).toBeNull();
    expect(page.items.some((item) => "contentJson" in item)).toBe(false);
  });

  it("keeps JSON reads unchanged without contentFormat", async () => {
    const apiKey = await seedAdminApiKey();
    const id = await createPost(apiKey, { contentJson: paragraph("Plain") });

    const post = await readPost(apiKey, id);
    expect(post.contentJson).toEqual(paragraph("Plain"));
    expect(post).not.toHaveProperty("contentMarkdown");

    const response = await callAdminApi(
      apiKey,
      "/admin/posts?includeContent=true&sortBy=id&sortDir=ASC",
    );
    const page = (await response.json()) as {
      items: Array<{ id: number } & ReadPost>;
    };
    const item = page.items.find((entry) => entry.id === id);
    expect(item?.contentJson).toEqual(paragraph("Plain"));
    expect(item).not.toHaveProperty("contentMarkdown");
  });

  it("refuses a local image and names it", async () => {
    const apiKey = await seedAdminApiKey();
    const id = await createPost(apiKey, { contentJson: paragraph("Before") });

    const response = await callAdminApi(apiKey, `/admin/posts/${id}`, {
      method: "PATCH",
      body: {
        data: {
          contentMarkdown:
            "![ok](https://example.com/a.png)\n\n![local](./photos/b.png)",
        },
      },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      message: string;
      data: { images: Array<string> };
    };
    expect(body.code).toBe("MARKDOWN_IMAGE_INVALID");
    expect(body.message).toContain("./photos/b.png");
    expect(body.data.images).toEqual(["./photos/b.png"]);
    expect((await readPost(apiKey, id)).contentJson).toEqual(
      paragraph("Before"),
    );

    const create = await callAdminApi(apiKey, "/admin/posts", {
      method: "POST",
      body: {
        data: { title: "Local", contentMarkdown: "![x](C:/x.png)" },
      },
    });
    expect(create.status).toBe(400);
    expect(((await create.json()) as { code: string }).code).toBe(
      "MARKDOWN_IMAGE_INVALID",
    );
  });

  it("refuses contentJson and contentMarkdown together", async () => {
    const apiKey = await seedAdminApiKey();
    const id = await createPost(apiKey, { contentJson: paragraph("Before") });
    const both = {
      contentJson: paragraph("JSON"),
      contentMarkdown: "Markdown",
    };

    const patch = await callAdminApi(apiKey, `/admin/posts/${id}`, {
      method: "PATCH",
      body: { data: both },
    });
    expect(patch.status).toBe(400);
    expect(((await patch.json()) as { code: string }).code).toBe(
      "CONTENT_FORMAT_AMBIGUOUS",
    );
    expect((await readPost(apiKey, id)).contentJson).toEqual(
      paragraph("Before"),
    );

    const create = await callAdminApi(apiKey, "/admin/posts", {
      method: "POST",
      body: { data: { title: "Both", ...both } },
    });
    expect(create.status).toBe(400);
  });

  it("looks up the title, cover and length of a new video", async () => {
    const apiKey = await seedAdminApiKey();
    lookUpVideo.mockResolvedValue(BILIBILI_META);

    const id = await createPost(apiKey, {
      contentMarkdown: `Watch this:\n\n${BILIBILI_LINK}`,
    });

    expect(lookUpVideo).toHaveBeenCalledWith({
      provider: "bilibili",
      videoId: "BV1fK4y1s7Qf",
      page: 2,
      start: 90,
    });
    const video = (await readPost(apiKey, id)).contentJson?.content?.[1];
    expect(video).toEqual({
      type: "video",
      attrs: {
        provider: "bilibili",
        videoId: "BV1fK4y1s7Qf",
        page: 2,
        start: 90,
        ...BILIBILI_META,
      },
    });

    // Writing the same video back keeps what it has, without asking again.
    lookUpVideo.mockClear();
    const patch = await callAdminApi(apiKey, `/admin/posts/${id}`, {
      method: "PATCH",
      body: { data: { contentMarkdown: `Again:\n\n${BILIBILI_LINK}` } },
    });
    expect(patch.status).toBe(200);
    expect(lookUpVideo).not.toHaveBeenCalled();
    expect((await readPost(apiKey, id)).contentJson?.content?.[1]).toEqual(
      video,
    );
  });

  it("still writes when the video lookup fails", async () => {
    const apiKey = await seedAdminApiKey();
    lookUpVideo.mockRejectedValue(new Error("provider down"));

    const id = await createPost(apiKey, {
      contentMarkdown: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect((await readPost(apiKey, id)).contentJson?.content).toEqual([
      {
        type: "video",
        attrs: {
          provider: "youtube",
          videoId: "dQw4w9WgXcQ",
          page: null,
          start: null,
          title: null,
          cover: null,
          duration: null,
        },
      },
    ]);
  });
});
