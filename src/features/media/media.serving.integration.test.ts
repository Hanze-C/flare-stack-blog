import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyWorkersCachePolicy } from "@/features/cache/workers-cache-policy";
import { handleImageRequest } from "./service/media.service";

/**
 * What /images/{key} answers. In production the image route hands the
 * request to handleImageRequest, and App.fetch runs the Workers cache policy
 * over the response before Workers Caching stores it, so a cached copy
 * replays exactly these headers.
 */
async function serve(key: string, url: string) {
  const request = new Request(url, { headers: { Accept: "image/webp" } });
  const response = await handleImageRequest(env, key, request);
  return applyWorkersCachePolicy(request, response);
}

const SCRIPTED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';

describe("serving /images/{key}", () => {
  it("serves an SVG as a sandboxed document that cannot run script", async () => {
    await env.R2.put("drawing.svg", SCRIPTED_SVG, {
      httpMetadata: { contentType: "image/svg+xml" },
    });

    const response = await serve(
      "drawing.svg",
      "http://localhost:3000/images/drawing.svg",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toMatch(/(^|;\s*)sandbox(;|$)/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
