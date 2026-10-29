import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { lazy, onError, unlazyRouter } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { ApiContext } from "./context";
import { router } from "./router";

const schemaConverter = new ZodToJsonSchemaConverter();

// API-wide rules a client needs before its first call. Per-field details
// belong to the schemas; the Agent Skill points agents here.
const API_DESCRIPTION = `Paths are relative to the server URL.

## Authentication

Admin routes require a browser session cookie or an Admin API Key in the \`x-api-key\` header. Operations do not declare security one by one: send the header on every request. A key acts as the Admin who issued it, with that Admin's content-management permissions; it cannot create or revoke API Keys. 401 means the key is missing, wrong or revoked.

## Client fingerprint

Send a browser \`User-Agent\` on every request, including the one for this document. A 403 whose body is Cloudflare error 1010 / \`browser_signature_banned\` is the site's WAF blocking a non-browser client, not a permission error: resend with a browser \`User-Agent\` and the same key.

## Drafts and publishing

Creating or saving a Post changes its draft only, its Category and Tags included. Publishing replaces the Post's Public Content Snapshot (what the public site lists, renders and searches, together with the Category and Tags it shows the Post under) with the current draft and records a Post Revision; publishing again is safe. Unpublishing discards the snapshot: the Post becomes a Draft Post and leaves the public site. Categories and Tags themselves have no draft: creating, renaming and deleting one take effect on the public site at once, and deleting one removes it from every Published Post that shows it. A Published Post's public page is \`/post/{publicSlug}\` on the site origin; public pages are cached, so a change can take some seconds to show.

## saveToken and Edit Conflict

Every Post carries an opaque \`saveToken\`, returned by each read of the Post and by each write to it. Any write to the Post (content, title, tags, category, cover, publish, unpublish, restoring a Post Revision) replaces it. Saving (PATCH, body \`{ data, saveToken }\`) and publishing (body \`{ saveToken }\`) take the token you read. If the Post was saved since, by anyone and for any field, the request answers 409 with error code \`EDIT_CONFLICT\` and \`data.saveToken\` set to the current token, and nothing is written: read the Post again and decide. Without a token the request writes unconditionally.

## Markdown content

Post reads take \`contentFormat=markdown\` (default \`json\`, TipTap JSON) and then answer \`contentMarkdown\` (string or null) in place of \`contentJson\`. Creating and saving take either \`contentJson\` or \`contentMarkdown\` in \`data\`; sending both answers 400. Markdown is parsed as the editor parses pasted Markdown, and reads serialize back to the same form:

- Headings are levels 2 to 4.
- A video link alone on a line is a video block. Its title, cover and duration are looked up on write and left empty when the lookup fails.
- Tables keep column alignment; a Markdown write resets column widths to equal.
- Inline math is \`$…$\`; block math has \`$$\` alone on the lines before and after it.
- Fenced code blocks carry their language.
- An image must be an http(s) address or a \`/images/…\` Media path. Any other source, such as a local file path, answers 400 naming the image: upload the file as Media first and use its path.`;

type PluginInit = OpenAPIReferencePlugin<ApiContext>["init"];

// The spec generator lists loaded procedures before lazy ones; handing it the
// whole router behind a single lazy keeps the spec in the router's own order.
// The generator resolves a lazy root, though Router's type has no such case.
class ReferencePlugin extends OpenAPIReferencePlugin<ApiContext> {
  override init(...[options, appRouter]: Parameters<PluginInit>) {
    const wholeRouter = lazy(async () => ({
      default: await unlazyRouter(appRouter),
    }));
    super.init(options, wholeRouter as unknown as typeof appRouter);
  }
}

export const openAPIHandler = new OpenAPIHandler(router, {
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
    new ReferencePlugin({
      schemaConverters: [schemaConverter],
      docsPath: "/docs",
      specPath: "/spec.json",
      specGenerateOptions: {
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
