import { env } from "cloudflare:workers";
import { createMockExecutionCtx, seedAdminApiKey } from "tests/test-utils";
import { describe, expect, it } from "vitest";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

/**
 * What the Admin HTTP API refuses before it writes anything: fields it does
 * not know, pagination that is not a whole number in range, and post, Category
 * and Tag fields outside their rules.
 */

type AdminPost = {
  id: number;
  title: string;
  slug: string;
  saveToken: string;
};

async function callApi(
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

async function createPost(apiKey: string, title: string) {
  const response = await callApi(apiKey, "/admin/posts", {
    method: "POST",
    body: { data: { title } },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: number; saveToken: string };
}

async function readPost(apiKey: string, id: number) {
  const response = await callApi(apiKey, `/admin/posts/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AdminPost;
}

function patchPost(apiKey: string, id: number, body: Record<string, unknown>) {
  return callApi(apiKey, `/admin/posts/${id}`, { method: "PATCH", body });
}

describe("unknown fields", () => {
  it("refuses a misspelt saveToken instead of saving unconditionally", async () => {
    const apiKey = await seedAdminApiKey();
    const { id, saveToken } = await createPost(apiKey, "Guarded");

    const response = await patchPost(apiKey, id, {
      data: { title: "Overwritten" },
      save_token: saveToken,
    });

    expect(response.status).toBe(400);
    const after = await readPost(apiKey, id);
    expect(after.title).toBe("Guarded");
    expect(after.saveToken).toBe(saveToken);
  });

  it("refuses an unknown field on a body that has none of its own", async () => {
    const apiKey = await seedAdminApiKey();
    const { id, saveToken } = await createPost(apiKey, "Draft");

    const response = await callApi(apiKey, `/admin/posts/${id}/unpublish`, {
      method: "POST",
      body: { saveToken },
    });

    expect(response.status).toBe(400);
  });

  it("refuses an unknown query parameter", async () => {
    const apiKey = await seedAdminApiKey();

    const response = await callApi(apiKey, "/admin/posts?stauts=draft");

    expect(response.status).toBe(400);
  });
});

async function codeOf(response: Response) {
  return ((await response.json()) as { code: string }).code;
}

function publish(apiKey: string, id: number) {
  return callApi(apiKey, `/admin/posts/${id}/publish`, {
    method: "POST",
    body: {},
  });
}

describe("pagination", () => {
  it.each([
    ["/admin/posts?limit=2.5"],
    ["/admin/posts?limit=-5"],
    ["/admin/posts?limit=0"],
    ["/admin/posts?limit=51"],
    ["/admin/posts?offset=-1"],
    ["/admin/posts?offset=1.5"],
    ["/admin/media?limit=2.5"],
    ["/admin/media?cursor=-1"],
    ["/admin/friend-links?offset=-1"],
    ["/posts?limit=2.5"],
    ["/posts?cursor=-1"],
    ["/posts/1/comments?limit=101"],
  ])("refuses %s with 400", async (path) => {
    const apiKey = await seedAdminApiKey();

    const response = await callApi(apiKey, path);

    expect(response.status).toBe(400);
  });

  it("takes whole numbers within range", async () => {
    const apiKey = await seedAdminApiKey();
    await createPost(apiKey, "One");
    await createPost(apiKey, "Two");

    const response = await callApi(apiKey, "/admin/posts?limit=1&offset=1");

    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: Array<unknown> };
    expect(page.items).toHaveLength(1);
  });
});

describe("post title and slug", () => {
  it("trims the title and refuses an empty or overlong one", async () => {
    const apiKey = await seedAdminApiKey();
    const { id } = await createPost(apiKey, "  Spaced  ");
    expect((await readPost(apiKey, id)).title).toBe("Spaced");

    for (const title of ["", "   ", "x".repeat(201)]) {
      const response = await patchPost(apiKey, id, { data: { title } });
      expect(response.status).toBe(400);
    }
    const create = await callApi(apiKey, "/admin/posts", {
      method: "POST",
      body: { data: { title: "x".repeat(201) } },
    });
    expect(create.status).toBe(400);
    expect((await readPost(apiKey, id)).title).toBe("Spaced");
  });

  it.each([
    [""],
    ["   "],
    ["a/../x?y#z"],
    ["with space"],
    ["percent%20"],
    ["back\\slash"],
    ["tab\there"],
    [".."],
    ["x".repeat(201)],
  ])("refuses the slug %j", async (slug) => {
    const apiKey = await seedAdminApiKey();
    const { id } = await createPost(apiKey, "Slug rules");
    const before = await readPost(apiKey, id);

    const response = await patchPost(apiKey, id, { data: { slug } });

    expect(response.status).toBe(400);
    expect((await readPost(apiKey, id)).slug).toBe(before.slug);
  });

  it("takes a trimmed slug in any script", async () => {
    const apiKey = await seedAdminApiKey();
    const { id } = await createPost(apiKey, "Unicode");

    const response = await patchPost(apiKey, id, {
      data: { slug: "  你好-world.v2  " },
    });

    expect(response.status).toBe(200);
    expect((await readPost(apiKey, id)).slug).toBe("你好-world.v2");
  });

  it("answers 409 SLUG_TAKEN for another post's slug in any case", async () => {
    const apiKey = await seedAdminApiKey();
    const first = await createPost(apiKey, "First");
    await patchPost(apiKey, first.id, { data: { slug: "taken-slug" } });
    const second = await createPost(apiKey, "Second");
    const before = await readPost(apiKey, second.id);

    for (const slug of ["taken-slug", "Taken-SLUG"]) {
      const response = await patchPost(apiKey, second.id, { data: { slug } });
      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe("SLUG_TAKEN");
    }
    const after = await readPost(apiKey, second.id);
    expect(after.slug).toBe(before.slug);
    expect(after.saveToken).toBe(before.saveToken);
  });

  it("answers 409 SLUG_TAKEN for the slug of another post's live page", async () => {
    const apiKey = await seedAdminApiKey();
    const live = await createPost(apiKey, "Live");
    await patchPost(apiKey, live.id, { data: { slug: "live-page" } });
    expect((await publish(apiKey, live.id)).status).toBe(200);
    // The draft moves on; the live page keeps the old slug until republished.
    await patchPost(apiKey, live.id, { data: { slug: "live-page-next" } });
    const other = await createPost(apiKey, "Other");

    const response = await patchPost(apiKey, other.id, {
      data: { slug: "LIVE-page" },
    });

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("SLUG_TAKEN");
  });

  it("lets a post keep its own slug and change its case", async () => {
    const apiKey = await seedAdminApiKey();
    const { id } = await createPost(apiKey, "Own");
    await patchPost(apiKey, id, { data: { slug: "own-slug" } });

    const same = await patchPost(apiKey, id, { data: { slug: "own-slug" } });
    expect(same.status).toBe(200);
    const recased = await patchPost(apiKey, id, { data: { slug: "Own-Slug" } });
    expect(recased.status).toBe(200);
  });

  it("refuses to publish a slug another live page has in another case", async () => {
    const apiKey = await seedAdminApiKey();
    const first = await createPost(apiKey, "First live");
    await patchPost(apiKey, first.id, { data: { slug: "shared" } });
    expect((await publish(apiKey, first.id)).status).toBe(200);
    await patchPost(apiKey, first.id, { data: { slug: "moved-on" } });
    const second = await createPost(apiKey, "Second live");
    // Written past the API's checks, as an older row may have been.
    await env.DB.prepare("UPDATE posts SET slug = 'SHARED' WHERE id = ?")
      .bind(second.id)
      .run();

    const response = await publish(apiKey, second.id);

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("PUBLIC_SLUG_TAKEN");
  });

  it("keeps saving and republishing a post whose old slug clashes in case", async () => {
    const apiKey = await seedAdminApiKey();
    const first = await createPost(apiKey, "Old one");
    await patchPost(apiKey, first.id, { data: { slug: "old-clash" } });
    expect((await publish(apiKey, first.id)).status).toBe(200);
    const second = await createPost(apiKey, "Old two");
    // Two pages that differ only in case, from before the check existed.
    await env.DB.prepare(
      "UPDATE posts SET slug = 'OLD-CLASH', public_slug = 'OLD-CLASH' WHERE id = ?",
    )
      .bind(second.id)
      .run();

    const saved = await patchPost(apiKey, second.id, {
      data: { slug: "OLD-CLASH", title: "Old two, edited" },
    });
    expect(saved.status).toBe(200);
    expect((await publish(apiKey, second.id)).status).toBe(200);
  });

  it("generates a slug no other post uses in any case", async () => {
    const apiKey = await seedAdminApiKey();
    const { id } = await createPost(apiKey, "Mixed");
    await env.DB.prepare("UPDATE posts SET slug = 'Hello-World' WHERE id = ?")
      .bind(id)
      .run();

    const response = await callApi(
      apiKey,
      "/admin/posts/slug?title=hello%20world",
    );

    expect(((await response.json()) as { slug: string }).slug).toBe(
      "hello-world-1",
    );
  });

  it("cuts a slug generated from a long title to fit", async () => {
    const apiKey = await seedAdminApiKey();
    const { id } = await createPost(apiKey, "a".repeat(200));

    const { slug } = await readPost(apiKey, id);

    expect(slug.length).toBeLessThanOrEqual(200);
    expect((await patchPost(apiKey, id, { data: { slug } })).status).toBe(200);
  });
});
