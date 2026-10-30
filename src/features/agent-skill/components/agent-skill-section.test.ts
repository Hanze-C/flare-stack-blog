// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatDate } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { PairingStatus } from "../queries";
import { AgentSkillSection } from "./agent-skill-section";

const pairing = vi.hoisted(() => ({
  generate: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
}));
const authKeys = vi.hoisted(() => ({ list: vi.fn(), delete: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/orpc", () => ({
  orpcClient: { pairing: { admin: pairing } },
}));
vi.mock("@/lib/auth/auth-client", () => ({
  getAuthClient: () => ({ apiKey: authKeys }),
}));
vi.mock("@/features/config/queries", () => ({
  siteDomainQuery: {
    queryKey: ["site-domain"],
    queryFn: async () => "blog.example.com",
  },
}));
vi.mock("@tanstack/react-router", () => ({
  ClientOnly: ({ children }: { children: ReactNode }) => children,
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
}));

const connectedAt = "2026-10-30T08:00:00.000Z";
const waiting: PairingStatus = {
  state: "waiting",
  code: "ABCD-EFGH",
  expiresAt: "2026-10-30T08:10:00.000Z",
};
const connected: PairingStatus = {
  state: "connected",
  agent: { name: "Claude Code", apiKeyId: "key-1", connectedAt },
};

const pairedKey = {
  id: "key-1",
  name: "Claude Code · 2026-10-30",
  start: "fsb_ab",
  createdAt: connectedAt,
  lastRequest: "2026-10-30T09:30:00.000Z",
  metadata: { createdBy: "pairing" },
};
const manualKey = {
  id: "key-2",
  name: "CI script",
  start: "fsb_cd",
  createdAt: connectedAt,
  lastRequest: null,
  metadata: null,
};

function mountPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["site-domain"], "blog.example.com");
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AgentSkillSection),
    ),
  );
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Lets a result that arrived at the last tick reach the rendered page. */
async function settle() {
  await act(async () => {
    for (let step = 0; step < 3; step++) {
      await vi.advanceTimersByTimeAsync(50);
    }
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    // Query results reach React through a zero-delay timer, and may queue another.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  // The copy is pinned in Chinese; jsdom would otherwise prefer English.
  document.cookie = "LOCALE=zh";
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  pairing.status.mockResolvedValue({ state: "none" });
  pairing.generate.mockResolvedValue({
    code: "ABCD-EFGH",
    expiresAt: waiting.expiresAt,
  });
  pairing.cancel.mockResolvedValue(undefined);
  authKeys.list.mockResolvedValue({ data: { apiKeys: [] }, error: null });
  authKeys.delete.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  document.cookie = "LOCALE=; max-age=0";
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("lays out the install, pair and try steps in order", async () => {
  mountPage();
  await flush();
  const headings = screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
  expect(headings).toEqual([
    `1 ${m.agent_skill_step_install()}`,
    `2 ${m.agent_skill_step_pair()}`,
    `3 ${m.agent_skill_step_try()}`,
    m.agent_skill_agents_title(),
  ]);
});

it("shows the install command with a copy button and the zip link pinned to this version", async () => {
  mountPage();
  await flush();
  const command = document.querySelector("code");
  expect(command?.textContent).toBe(
    `npx skills add https://github.com/du2333/flare-stack-blog/tree/v${__APP_VERSION__}/.agents/skills/flare-stack-blog -g`,
  );
  expect(
    screen.getAllByRole("button", { name: m.common_copy_code() }),
  ).toHaveLength(1);
  const download = screen.getByRole("link", {
    name: m.agent_skill_download({ version: __APP_VERSION__ }),
  });
  expect(download.getAttribute("href")).toBe(
    `https://github.com/du2333/flare-stack-blog/releases/download/v${__APP_VERSION__}/flare-stack-blog-skills-v${__APP_VERSION__}.zip`,
  );
});

it("offers the four example instructions, each with a copy button, and the draft note", async () => {
  mountPage();
  await flush();
  for (const text of [
    "列出最近的草稿",
    "把本地的 notes.md 整理成一篇草稿，图片一并上传",
    "检查草稿《…》有哪些未发布的修改，确认后发布",
    "为最近三篇文章补写摘要，保存为草稿",
  ]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  expect(
    screen.getAllByRole("button", { name: m.agent_skill_try_copy() }),
  ).toHaveLength(4);
  expect(
    screen.getByText(
      "agent 的修改先保存为草稿，发布后才会出现在已发布页面；分类与标签的新建、改名、删除即时生效。",
    ),
  ).toBeTruthy();
});

it("starts with a generate button and no polling when there is no code", async () => {
  mountPage();
  await flush();
  expect(
    screen.getByRole("button", { name: m.agent_skill_pair_generate() }),
  ).toBeTruthy();
  await tick(6000);
  expect(pairing.status).toHaveBeenCalledTimes(1);
});

it("treats a cancelled code like no code", async () => {
  pairing.status.mockResolvedValue({ state: "cancelled" });
  mountPage();
  await flush();
  expect(
    screen.getByRole("button", { name: m.agent_skill_pair_generate() }),
  ).toBeTruthy();
});

it("generates a code and shows the sentence for the agent with the configured domain", async () => {
  mountPage();
  await flush();
  pairing.status.mockResolvedValue(waiting);
  fireEvent.click(
    screen.getByRole("button", { name: m.agent_skill_pair_generate() }),
  );
  await flush();
  expect(pairing.generate).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText(
      "使用 flare-stack-blog skill 连接 https://blog.example.com，配对码：ABCD-EFGH",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: m.agent_skill_pair_copy() }),
  ).toBeTruthy();
  expect(screen.getByText(m.agent_skill_pair_waiting())).toBeTruthy();
});

it("writes the code as ABCD-EFGH whatever case or separator the server uses", async () => {
  pairing.status.mockResolvedValue({ ...waiting, code: "abcdefgh" });
  mountPage();
  await flush();
  expect(screen.getByText(/配对码：ABCD-EFGH$/)).toBeTruthy();
});

it("polls every 2 seconds while a code is waiting and stops once an agent connects", async () => {
  pairing.status.mockResolvedValue(waiting);
  mountPage();
  await flush();
  expect(pairing.status).toHaveBeenCalledTimes(1);
  await tick(1999);
  expect(pairing.status).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(pairing.status).toHaveBeenCalledTimes(2);

  pairing.status.mockResolvedValue(connected);
  await tick(2000);
  expect(pairing.status).toHaveBeenCalledTimes(3);
  await settle();
  expect(
    screen.getByText(
      m.agent_skill_pair_connected({
        name: "Claude Code",
        time: formatDate(connectedAt, { includeTime: true }),
      }),
    ),
  ).toBeTruthy();
  await tick(6000);
  expect(pairing.status).toHaveBeenCalledTimes(3);
});

it("does not poll while the page is hidden", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  pairing.status.mockResolvedValue(waiting);
  mountPage();
  await flush();
  await tick(6000);
  expect(pairing.status).toHaveBeenCalledTimes(1);
});

it("reloads the connected agent into the key list", async () => {
  pairing.status.mockResolvedValue(waiting);
  authKeys.list.mockResolvedValue({ data: { apiKeys: [] }, error: null });
  mountPage();
  await flush();
  expect(authKeys.list).toHaveBeenCalledTimes(1);
  pairing.status.mockResolvedValue(connected);
  authKeys.list.mockResolvedValue({
    data: { apiKeys: [pairedKey] },
    error: null,
  });
  await tick(2000);
  await settle();
  expect(authKeys.list).toHaveBeenCalledTimes(2);
  expect(screen.getByText(pairedKey.name)).toBeTruthy();
});

it("cancels a waiting code and returns to the start", async () => {
  pairing.status.mockResolvedValue(waiting);
  mountPage();
  await flush();
  pairing.status.mockResolvedValue({ state: "cancelled" });
  fireEvent.click(
    screen.getByRole("button", { name: m.agent_skill_pair_cancel() }),
  );
  await flush();
  expect(pairing.cancel).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: m.agent_skill_pair_generate() }),
  ).toBeTruthy();
});

it("regenerates from a waiting code", async () => {
  pairing.status.mockResolvedValue(waiting);
  mountPage();
  await flush();
  fireEvent.click(
    screen.getByRole("button", { name: m.agent_skill_pair_regenerate() }),
  );
  await flush();
  expect(pairing.generate).toHaveBeenCalledTimes(1);
});

it("says an expired code has expired and offers a new one", async () => {
  pairing.status.mockResolvedValue({ state: "expired" });
  mountPage();
  await flush();
  expect(screen.getByText("配对码已过期")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await flush();
  expect(pairing.generate).toHaveBeenCalledTimes(1);
  await tick(6000);
  expect(pairing.status).toHaveBeenCalledTimes(2);
});

it("shows which agent connected and when", async () => {
  pairing.status.mockResolvedValue(connected);
  mountPage();
  await flush();
  expect(
    screen.getByText(
      `已连接：Claude Code，${formatDate(connectedAt, { includeTime: true })}`,
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "不是此 agent？撤销" }),
  ).toBeTruthy();
});

it("asks before revoking, then deletes the key the code issued", async () => {
  pairing.status.mockResolvedValue(connected);
  mountPage();
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "不是此 agent？撤销" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(
    m.agent_skill_pair_revoke_desc({ name: "Claude Code" }),
  );
  expect(authKeys.delete).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: m.agent_skill_pair_revoke_confirm(),
    }),
  );
  await flush();
  expect(authKeys.delete).toHaveBeenCalledWith({ keyId: "key-1" });
  expect(
    screen.getByText(m.agent_skill_pair_revoked({ name: "Claude Code" })),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "不是此 agent？撤销" }),
  ).toBeNull();
});

it("leaves the key alone when the revoke confirmation is dismissed", async () => {
  pairing.status.mockResolvedValue(connected);
  mountPage();
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "不是此 agent？撤销" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: m.common_cancel(),
    }),
  );
  await tick(300);
  expect(authKeys.delete).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "不是此 agent？撤销" }),
  ).toBeTruthy();
});

it("lists only the agents connected by pairing, with their last use", async () => {
  authKeys.list.mockResolvedValue({
    data: { apiKeys: [pairedKey, manualKey] },
    error: null,
  });
  mountPage();
  await flush();
  const list = screen.getByRole("table");
  expect(within(list).getByText(pairedKey.name)).toBeTruthy();
  expect(within(list).queryByText(manualKey.name)).toBeNull();
  expect(
    within(list).getByText(
      formatDate(pairedKey.lastRequest, { includeTime: true }),
    ),
  ).toBeTruthy();
});

it("says a paired agent has not been used yet", async () => {
  authKeys.list.mockResolvedValue({
    data: { apiKeys: [{ ...pairedKey, lastRequest: null }] },
    error: null,
  });
  mountPage();
  await flush();
  expect(screen.getByText(m.agent_skill_agents_never_used())).toBeTruthy();
});

it("shows an empty list when no key came from pairing", async () => {
  authKeys.list.mockResolvedValue({
    data: { apiKeys: [manualKey] },
    error: null,
  });
  mountPage();
  await flush();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText(m.agent_skill_agents_empty())).toBeTruthy();
});

it("deletes a paired agent's key after confirmation", async () => {
  authKeys.list.mockResolvedValue({
    data: { apiKeys: [pairedKey] },
    error: null,
  });
  mountPage();
  await flush();
  fireEvent.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: m.settings_api_keys_delete(),
    }),
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(
    m.settings_api_keys_delete_desc({ name: pairedKey.name }),
  );
  expect(authKeys.delete).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: m.settings_api_keys_delete_confirm(),
    }),
  );
  await flush();
  expect(authKeys.delete).toHaveBeenCalledWith({ keyId: "key-1" });
});

it("offers a retry when the pairing status cannot be read", async () => {
  pairing.status.mockRejectedValueOnce(new Error("offline"));
  mountPage();
  await flush();
  expect(screen.getByText(m.agent_skill_pair_load_failed())).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: m.settings_design_retry() }),
  );
  await flush();
  expect(
    screen.getByRole("button", { name: m.agent_skill_pair_generate() }),
  ).toBeTruthy();
});
