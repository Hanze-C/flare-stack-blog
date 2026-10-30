import { SmartCoercionPlugin } from "@orpc/json-schema";
import { ORPCError } from "@orpc/client";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { StandardOpenAPIMatcher } from "@orpc/openapi/standard";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { MAX_FILE_SIZE } from "@/features/media/media.schema";
import {
  bodyLimitOf,
  payloadTooLargeResponse,
  readBodyWithin,
} from "./body-limit";
import type { ApiContext } from "./context";
import { OPENAPI_COMPONENTS } from "./openapi-components";
import {
  DOCUMENT_PATHS,
  OpenAPIDocumentPlugin,
} from "./openapi-document-plugin";
import { CanonicalPathIdPlugin } from "./path-ids";
import { router } from "./router";

const schemaConverter = new ZodToJsonSchemaConverter();

// API-wide rules a client needs before its first call. Per-field details
// belong to the schemas; the Agent Skill points agents here.
const API_DESCRIPTION = `## Reading this document

The whole document is large, so read it in parts. First GET \`/api/spec/index.json\` on the site origin: this description and every operation's \`operationId\`, method, path, summary and tags. Then GET \`/api/spec.json?operationIds=<id>,<id>\` for the operations you will call, or \`?tags=<tag>\` (URL-encoded) for all of a tag's: an OpenAPI document with just those operations and every schema they reference. \`/api/spec.json\` with no query is the whole document.

Paths are relative to the server URL.

## Authentication

Admin routes require a browser session cookie or an Admin API Key in the \`x-api-key\` header. Operations do not declare security one by one: send the header on every request. A key acts as the Admin who issued it, with that Admin's content-management permissions; it cannot create or revoke API Keys. 401 means the key is missing, wrong or revoked. Public pages and public read operations need no key.

## Client fingerprint

Send a browser \`User-Agent\` on every request, including the one for this document. A 403 whose body is Cloudflare error 1010 / \`browser_signature_banned\` is the site's WAF blocking a non-browser client, not a permission error: resend with a browser \`User-Agent\` and the same key.

## Drafts and publishing

Creating or saving a Post changes its draft only, its Category and Tags included. Creating with \`data\` makes a new draft; without \`data\`, creating returns an existing empty draft when there is one, so send the content when you create. Publishing replaces the Post's Public Content Snapshot (what the public site lists, renders and searches, together with the Category and Tags it shows the Post under) with the current draft and records a Post Revision; publishing again is safe. Unpublishing discards the snapshot: the Post becomes a Draft Post and leaves the public site. Categories and Tags themselves have no draft: creating, renaming and deleting one take effect on the public site at once, and deleting one removes it from every Published Post that shows it. A Published Post's public page is \`/post/{publicSlug}\` on the site origin; public pages are cached, so a change can take some seconds to show. Changing a Published Post's slug and publishing again leaves the old URL unreachable (there is no redirect), and Category and Tag pages are addressed by name, so renaming one changes its public URL. Pinning a Post takes effect at once and is not part of publishing.

## saveToken and Edit Conflict

Every Post carries an opaque \`saveToken\`, returned by each read of the Post and by each write to it. Saving the Post's draft (content, title, tags, category, cover, restoring a Post Revision), discarding its Unpublished Changes, publishing and unpublishing a Published Post replace it; pinning, and a save that changes nothing, keep it. Saving (PATCH, body \`{ data, saveToken }\`), setting the Post's Tags (body \`{ tagIds, saveToken }\`), restoring a Post Revision, discarding Unpublished Changes and publishing (body \`{ saveToken }\`) take the token you read. Unpublishing takes none, since it does not change the draft, but unpublishing a Published Post replaces the token: read again before your next write. Request bodies refuse fields they do not declare, so a misspelt \`saveToken\` answers 400 rather than writing unguarded. If the Post was saved since, by anyone and for any part of its draft, the request answers 409 with error code \`EDIT_CONFLICT\` and \`data.saveToken\` set to the current token, and nothing is written: read the Post again and decide. Without a token, saving, setting Tags and publishing write unconditionally; restoring a Post Revision and discarding Unpublished Changes guard themselves with the token of the read they start from.

## Markdown content

Post and Post Revision reads, and saves, take \`contentFormat=markdown\` (default \`json\`, TipTap JSON) and then answer \`contentMarkdown\` (null when the Post has no body) in place of \`contentJson\`. Creating and saving take either \`contentJson\` or \`contentMarkdown\` in \`data\`; sending both answers 400. Markdown is parsed as the editor parses pasted Markdown, and reads serialize back to the same form:

- Headings are levels 2 to 4: when the Markdown has an H1, every heading moves one level down, and anything deeper than level 4 becomes level 4.
- A video link alone on a line is a video block. Its title, cover and duration are looked up on write and left empty when the lookup fails.
- Tables keep column alignment; a Markdown write resets column widths to equal.
- Inline math is \`$…$\`; block math has \`$$\` alone on the lines before and after it.
- Fenced code blocks carry their language.
- An image must be an http(s) address or the \`/images/…\` path of existing Media. Any other source, such as a local file path, answers 400 naming the image, and so does a Media path no Media has, unless the draft already shows it: upload the file as Media first and use its path.

## Media

Upload a file as multipart form data to the Media upload operation; its answer carries the \`/images/{key}\` path to use in Markdown and as a Post's cover. Media that a Post, a Public Content Snapshot or a Post Revision uses cannot be deleted. Deleting unused Media, rebuilding the search index and purging caches act on the whole site.

## Errors

Every error answers JSON with \`code\`, \`status\` and \`message\`; the errors an operation declares carry \`defined: true\` and may carry \`data\`. A request that fails validation answers 400 \`BAD_REQUEST\` with \`data.issues\`, each naming the path of a field and what is wrong with it: correct those fields and resend. 404 with a declared code (such as \`POST_NOT_FOUND\`) means what you named does not exist; 404 \`ROUTE_NOT_FOUND\` and 405 \`METHOD_NOT_ALLOWED\` mean the call itself is wrong, so check the path and method against this document. 413 \`PAYLOAD_TOO_LARGE\` means the request body is too large; 413 \`POST_CONTENT_TOO_LARGE\` means a Post's body, or the snapshot publishing would store, is too large to keep, and nothing was written. After a timeout or a 5xx, read before retrying: the write may have landed.`;

export const openAPIHandler = new OpenAPIHandler(router, {
  adapterInterceptors: [
    async (options) => {
      const limit = bodyLimitOf(options.request, MAX_FILE_SIZE);
      const request = await readBodyWithin(options.request, limit);
      if (!request) {
        return { matched: true, response: payloadTooLargeResponse(limit) };
      }
      return options.next({ ...options, request });
    },
  ],
  interceptors: [
    onError((error) => {
      console.error(
        JSON.stringify({
          message: "API error",
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }),
  ],
  plugins: [
    new SmartCoercionPlugin({
      schemaConverters: [schemaConverter],
    }),
    new CanonicalPathIdPlugin({ schemaConverter }),
    new OpenAPIDocumentPlugin<ApiContext>({
      schemaConverters: [schemaConverter],
      docsTitle: "Flare Stack Blog API",
      generateOptions: {
        commonSchemas: OPENAPI_COMPONENTS,
        info: {
          title: "Flare Stack Blog API",
          version: __APP_VERSION__,
          description: API_DESCRIPTION,
        },
        components: {
          securitySchemes: {
            apiKey: {
              type: "apiKey",
              in: "header",
              name: "x-api-key",
            },
          },
        },
      },
    }),
  ],
});

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// A second route table, built on the first request nobody matches: it lets
// that request tell an unknown path from a known one with another method.
let routeTable: StandardOpenAPIMatcher | undefined;

async function methodsAllowedAt(pathname: `/${string}`) {
  if (!routeTable) {
    routeTable = new StandardOpenAPIMatcher();
    routeTable.init(router);
  }
  const table = routeTable;
  const matches = await Promise.all(
    METHODS.map((method) => table.match(method, pathname)),
  );
  return METHODS.filter((_, index) => matches[index] !== undefined);
}

function errorResponse(
  error: ORPCError<string, unknown>,
  headers?: HeadersInit,
) {
  return Response.json(error.toJSON(), { status: error.status, headers });
}

/**
 * Answers an API request. A request no operation takes still answers JSON, so
 * a client can tell what it called wrong: 405 with `Allow` for a known path
 * with another method, 404 ROUTE_NOT_FOUND for a path nothing serves.
 */
export async function handleApiRequest(
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const { response } = await openAPIHandler.handle(request, {
    prefix: "/api",
    context,
  });
  if (response) return response;

  const url = new URL(request.url);
  const pathname =
    `/${url.pathname.replace(/^\/api/, "").replace(/^\/|\/$/g, "")}` as const;
  const allowed = (Object.values(DOCUMENT_PATHS) as Array<string>).includes(
    pathname,
  )
    ? ["GET"]
    : await methodsAllowedAt(pathname);
  if (allowed.length > 0) {
    return errorResponse(
      new ORPCError("METHOD_NOT_ALLOWED", {
        status: 405,
        message: `${request.method} is not allowed on ${url.pathname}. Use ${allowed.join(", ")}.`,
        data: { allow: allowed },
      }),
      { Allow: allowed.join(", ") },
    );
  }
  return errorResponse(
    new ORPCError("ROUTE_NOT_FOUND", {
      status: 404,
      message: `No API route matches ${request.method} ${url.pathname}. The routes are listed in /api${DOCUMENT_PATHS.index}.`,
    }),
  );
}
