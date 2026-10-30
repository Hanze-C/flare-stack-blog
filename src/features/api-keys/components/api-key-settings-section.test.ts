// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { m } from "@/paraglide/messages";
import { ApiKeySettingsSection } from "./api-key-settings-section";

const authKeys = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth/auth-client", () => ({
  getAuthClient: () => ({ apiKey: authKeys }),
}));
vi.mock("@tanstack/react-router", () => ({
  ClientOnly: ({ children }: { children: ReactNode }) => children,
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement("a", { href: to }, children),
}));

const createdAt = "2026-10-30T08:00:00.000Z";

beforeEach(() => {
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
  authKeys.list.mockResolvedValue({
    data: {
      apiKeys: [
        {
          id: "key-1",
          name: "Claude Code · 2026-10-30",
          start: "fsb_ab",
          createdAt,
          metadata: { createdBy: "pairing" },
        },
        {
          id: "key-2",
          name: "CI script",
          start: "fsb_cd",
          createdAt,
          metadata: null,
        },
        {
          id: "key-3",
          name: "Stored as text",
          start: "fsb_ef",
          createdAt,
          metadata: JSON.stringify({ createdBy: "pairing" }),
        },
      ],
    },
    error: null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mountPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ApiKeySettingsSection),
    ),
  );
}

it("marks the keys created by pairing, whichever way the metadata arrives", async () => {
  mountPage();
  const rows = await screen.findAllByRole("row");
  const badge = m.settings_api_keys_paired_badge();
  const cell = (name: string) =>
    rows.find((row) => within(row).queryByText(name))!;
  expect(
    within(cell("Claude Code · 2026-10-30")).getByText(badge),
  ).toBeTruthy();
  expect(within(cell("Stored as text")).getByText(badge)).toBeTruthy();
  expect(within(cell("CI script")).queryByText(badge)).toBeNull();
});

it("points to the Agent Skill tab instead of carrying the install hint", async () => {
  mountPage();
  await screen.findAllByRole("row");
  const link = screen.getByRole("link", {
    name: m.settings_api_keys_agent_pointer_link(),
  });
  expect(link.getAttribute("href")).toBe("/admin/settings/agent-skill");
  expect(document.body.textContent).not.toContain("npx skills add");
});
