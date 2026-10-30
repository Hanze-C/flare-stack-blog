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
