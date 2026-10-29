---
name: flare-stack-blog
description: Manage a Flare Stack Blog over its HTTP API with an Admin API Key. Use to connect a blog and its key, and for any change to or question about its posts, categories, tags, media and publishing.
---

# Manage a Flare Stack Blog

This Skill serves any Flare Stack Blog. Each blog describes itself at run time: its OpenAPI document gives every path, parameter, field, error and the API-wide rules. This Skill holds only what the document cannot: how to connect, the order of work, and the rules. Take every shape from the live document, never from memory or from another blog.

The human's instruction authorizes the work. Ask only for intent that is missing or ambiguous (which Post, what change, draft or published); decide wording yourself when it is delegated. When the target already matches the request, write nothing.

## 1. Connect

The blog and its key live in `$XDG_CONFIG_HOME/flare-stack-blog/config.toml` (`~/.config/flare-stack-blog/config.toml` when `XDG_CONFIG_HOME` is unset):

```toml
url = "https://blog.example.com"
api_key = "fsb_..."
```

`url` is the site origin, `https://<host>` with no path or trailing slash; `api_key` is an Admin API Key. When the file is missing, either value is empty, a stored key answers 401, or the human gives a new blog or key: ask the human for the origin and an API Key (an Admin issues one in the blog's admin settings; it is shown once), check it with one read-only admin call from the document, then write the file with mode `0600`, creating its directory. Done when one origin and a key that answers 200 are in hand.

Keep every file a task makes (headers, request and response bodies, Markdown drafts) in one working directory: the one the human names, or else one of its own, created private at the task's start: `mktemp -d` on macOS and Linux; on Windows, a new folder under `$env:TEMP` with inherited permissions removed and only the current user allowed. When the task ends, succeeded or not, delete the files you made there (and the directory, if you created it). The config file stays where it is.

The key goes only in the `x-api-key` header, and only to the configured origin. Keep it out of command arguments, URLs, logs, saved responses and replies: with curl, write the headers (the key and a browser User-Agent) to a file in the working directory and pass `-H @<file>`; send bodies with `--data-binary @<file>`. Stop on a redirect to another origin rather than follow it with the key. In Windows PowerShell, `curl` may be an alias of `Invoke-WebRequest`: call `curl.exe`.

## 2. Discover

At the start of every task, GET `<origin>/api/spec.json` with the same headers and follow it. Read its `info.description` first: it states authentication, the browser User-Agent requirement, drafts and publishing, the save guard and Edit Conflict, and Markdown content. Done when you hold the document and, for what you are about to touch, have read its operations and schemas, following every `$ref`. Operation paths are relative to the document's server URL; public pages, such as a Post's public page, are on the site origin itself.

When an entity has both public and admin operations, use the admin ones.

## 3. Change the draft

Every save changes the draft, a Post's Category and Tags included, and readers see it only once it is published. Categories and Tags themselves have no draft: creating, renaming and deleting one take effect at once on every Published Post that shows it (the document's description says so), so tell the human before renaming or deleting one that Published Posts use.

- **Resolve the target** by id, or by a search on the title or slug; several matches means ask which.
- **Read right before each write.** The Admin edits the same Posts in the browser, which autosaves as they type. Read the Post immediately before each save, build the save on what you just read, and send that read's `saveToken`. A Post saved in between is then kept and the save answers 409 instead of overwriting it. See [Conflicts](#conflicts).
- **Send only what changes.** Leave out every field you are not changing.
- **Content** is Markdown, read and written as the document's description states. Keep the images, videos and links you were not asked to change, and read the Post back after writing.
- A 400 names each problem: correct those values and resend; make no other change to get past it.

Make one human-intended change at a time, carried through to its end state, unless the human asked for several together.

## 4. Publish and verify

Follow the human's intent: publish when they ask to publish, keep the draft when they ask for a draft, and ask when it is unclear. Publishing takes the whole draft, so a change someone else left unpublished goes live with yours: when the draft holds changes you did not make, name them to the human first. Publish with the `saveToken` of the read the human approved, so what goes live is that draft.

After publishing, fetch the Post's public page and confirm the change shows. Public pages are cached: retry a few times over about 20 seconds before calling it failed.

To throw away a Published Post's unpublished changes, discard them with the document's discard operation rather than editing them back by hand: it returns the draft to what is published and keeps the discarded draft as a Post Revision.

To take a Post off the public site for now, unpublish it; the draft stays. Delete only when the human explicitly asks to delete.

## Conflicts

Every write to a Post's draft (saving it, setting its Tags, discarding its changes) and every publish states the `saveToken` of your latest read or write of it; unpublishing changes no draft and takes none. A 409 Edit Conflict means the Post was saved after you read it, and nothing was written. Never retry without the `saveToken`, and never resend the same one.

1. Read the Post again.
2. Compare it with the read your write was built on. When only your own earlier writes differ, re-apply your change to the new read and send its `saveToken`.
3. When someone else changed what you are changing, or you cannot tell, tell the human what changed under you and ask before writing. The Admin may still be typing: after a second 409 in a row, stop and ask.

## Errors

Quote the error body when an operation fails. 401: run the connect flow again. 403 with Cloudflare error 1010: the request lacked a browser User-Agent. After a timeout or a 5xx, re-read before retrying: the write may have landed.

## Report

Report the target, each change as before → after, where it stands (draft, published, unpublished), the HTTP status of each write, and the public URLs you checked.
