// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { createElement, useState } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminChromeProvider } from "@/components/admin/admin-chrome";
import { installDomShims } from "@/features/posts/editor/test-utils";
import { m } from "@/paraglide/messages";
import { PostEditor } from ".";
import type { PostEditorData, PostEditorProps, PostEditorSave } from "./types";

const publish = vi.hoisted(() => vi.fn());

vi.mock("@/lib/orpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/orpc")>();
  return {
    ...original,
    orpcClient: {
      posts: { admin: { publish } },
    },
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
  useBlocker: () => ({ status: "idle", proceed: vi.fn(), reset: vi.fn() }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/use-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-motion")>()),
  useMotionPresence: (open: boolean) => open,
}));

beforeEach(() => {
  publish.mockReset();
});

afterEach(cleanup);

const INITIAL: PostEditorProps["initialData"] = {
  id: 1,
  title: "Post",
  summary: "",
  slug: "post",
  contentJson: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "intro" }] },
      { type: "paragraph" },
    ],
  },
  publishedAt: null,
  tagIds: [],
  categoryId: null,
  hasPublicSnapshot: false,
  serverToday: "2026-10-05",
  coverMediaId: null,
  cover: null,
  saveToken: "token-1",
};

function editConflict(saveToken: string) {
  return new ORPCError("EDIT_CONFLICT", {
    status: 409,
    defined: true,
    data: { saveToken },
  });
}

/**
 * A post store that, like the server, refuses a save stating a token other
 * than the current one and replaces the token on every write.
 */
function createServer(token = "token-1") {
  let counter = 1;
  const server = {
    token,
    saved: null as PostEditorData | null,
    /** The token each save stated, and the token each one returned. */
    stated: [] as Array<string>,
    issued: [] as Array<string>,
    /** Another client's save, which replaces the token. */
    saveElsewhere() {
      counter += 1;
      server.token = `elsewhere-${counter}`;
    },
    save: (async (data, saveToken, acceptSaveToken) => {
      server.stated.push(saveToken);
      if (saveToken !== server.token) throw editConflict(server.token);
      counter += 1;
      server.token = `token-${counter}`;
      server.issued.push(server.token);
      server.saved = data;
      acceptSaveToken(server.token);
    }) as PostEditorSave,
  };
  return server;
}

/**
 * Stands in for the route, which mounts the editor afresh with the post as
 * stored once `onReload` resolves.
 */
function Host({
  onSave,
  stored,
}: {
  onSave: PostEditorSave;
  stored: () => PostEditorProps["initialData"];
}) {
  const [mounts, setMounts] = useState(0);
  return createElement(PostEditor, {
    key: mounts,
    initialData: stored(),
    publicSlug: null,
    onSave,
    onReload: async () => setMounts((count) => count + 1),
  });
}

async function renderPostEditorPage(
  onSave: PostEditorSave,
  stored: () => PostEditorProps["initialData"] = () => INITIAL,
) {
  installDomShims();
  render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        AdminChromeProvider,
        null,
        createElement(Host, { onSave, stored }),
      ),
    ),
  );
  return currentEditor();
}

function currentEditor() {
  return waitFor(() => {
    const dom = document.querySelector<HTMLElement & { editor?: Editor }>(
      ".ProseMirror",
    );
    if (!dom?.editor) throw new Error("The editor was not created");
    return dom.editor;
  });
}

function typeInto(editor: Editor, text: string) {
  act(() => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(text);
  });
}

const AUTOSAVE_WAIT = { timeout: 4000 };

it("saves the post without an unfilled image placeholder", async () => {
  const onSave = vi.fn<PostEditorSave>(async () => {});
  const editor = await renderPostEditorPage(onSave);

  act(() => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertImagePlaceholder();
  });
  expect(JSON.stringify(editor.getJSON())).toContain("imagePlaceholder");

  await waitFor(() => expect(onSave).toHaveBeenCalled(), AUTOSAVE_WAIT);
  const saved = onSave.mock.lastCall?.[0].contentJson;
  expect(JSON.stringify(saved)).not.toContain("imagePlaceholder");
  expect(saved?.content?.[0]).toEqual(INITIAL.contentJson?.content?.[0]);
});

it("states the token it read and the one each save returned", async () => {
  const server = createServer();
  const editor = await renderPostEditorPage(server.save);

  typeInto(editor, "one");
  await waitFor(() => expect(server.stated).toHaveLength(1), AUTOSAVE_WAIT);
  typeInto(editor, "two");
  await waitFor(() => expect(server.stated).toHaveLength(2), AUTOSAVE_WAIT);

  expect(server.stated).toEqual(["token-1", server.issued[0]]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("stops autosaving and says so when the post was saved elsewhere", async () => {
  const server = createServer();
  const save = vi.fn(server.save);
  const editor = await renderPostEditorPage(save);

  server.saveElsewhere();
  typeInto(editor, "mine");

  const notice = await screen.findByRole("alert", {}, AUTOSAVE_WAIT);
  expect(notice.textContent).toContain(m.editor_conflict_title());
  expect(notice.textContent).toContain(m.editor_conflict_desc());
  expect(save).toHaveBeenCalledTimes(1);

  typeInto(editor, " more");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toBe(notice);
});

it("overwrites with the token from the 409 and resumes autosaving", async () => {
  const server = createServer();
  const save = vi.fn(server.save);
  const editor = await renderPostEditorPage(save);

  server.saveElsewhere();
  const elsewhere = server.token;
  typeInto(editor, "mine");
  await screen.findByRole("alert", {}, AUTOSAVE_WAIT);

  fireEvent.click(
    screen.getByRole("button", { name: m.editor_conflict_overwrite() }),
  );

  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[1]).toBe(elsewhere);
  expect(JSON.stringify(server.saved?.contentJson)).toContain("mine");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

  typeInto(editor, " again");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3), AUTOSAVE_WAIT);
  expect(save.mock.calls[2]?.[1]).toBe(server.issued[0]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows the notice again when the overwrite is refused too", async () => {
  const server = createServer();
  const save = vi.fn(server.save);
  const editor = await renderPostEditorPage(save);

  server.saveElsewhere();
  typeInto(editor, "mine");
  await screen.findByRole("alert", {}, AUTOSAVE_WAIT);

  server.saveElsewhere();
  fireEvent.click(
    screen.getByRole("button", { name: m.editor_conflict_overwrite() }),
  );

  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await screen.findByRole("alert");
  expect(server.saved).toBeNull();
});

it("loads the latest version, drops local edits and resumes autosaving", async () => {
  const server = createServer();
  const save = vi.fn(server.save);
  let stored: PostEditorProps["initialData"] = INITIAL;
  const editor = await renderPostEditorPage(save, () => stored);

  server.saveElsewhere();
  stored = {
    ...INITIAL,
    title: "Edited elsewhere",
    saveToken: server.token,
    contentJson: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "theirs" }] },
      ],
    },
  };
  typeInto(editor, "mine");
  await screen.findByRole("alert", {}, AUTOSAVE_WAIT);

  fireEvent.click(
    screen.getByRole("button", { name: m.editor_conflict_load_latest() }),
  );

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  const reloaded = await waitFor(async () => {
    const next = await currentEditor();
    expect(next.getText()).toContain("theirs");
    return next;
  });
  expect(reloaded.getText()).not.toContain("mine");
  expect(save).toHaveBeenCalledTimes(1);

  typeInto(reloaded, " next");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2), AUTOSAVE_WAIT);
  expect(save.mock.calls[1]?.[1]).toBe(stored.saveToken);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("publishes with the current token and keeps the one it returns", async () => {
  const server = createServer();
  const save = vi.fn(server.save);
  const editor = await renderPostEditorPage(save);
  publish.mockResolvedValue({ success: true, saveToken: "published-1" });

  typeInto(editor, "draft");
  fireEvent.click(
    screen.getAllByRole("button", { name: m.editor_header_publish() })[0]!,
  );
  await waitFor(() => expect(publish).toHaveBeenCalled(), AUTOSAVE_WAIT);
  expect(publish).toHaveBeenCalledWith({
    id: 1,
    saveToken: server.issued[0],
  });

  server.token = "published-1";
  typeInto(editor, " after");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2), AUTOSAVE_WAIT);
  expect(save.mock.calls[1]?.[1]).toBe("published-1");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("surfaces the conflict when publishing is refused", async () => {
  const server = createServer();
  await renderPostEditorPage(server.save);
  publish.mockRejectedValue(editConflict("elsewhere-1"));

  fireEvent.click(
    screen.getAllByRole("button", { name: m.editor_header_publish() })[0]!,
  );

  await screen.findByRole("alert", {}, AUTOSAVE_WAIT);
  for (const button of screen.getAllByRole("button", {
    name: m.editor_header_publish(),
  })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});
