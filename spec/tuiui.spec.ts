import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { test as base } from "./test-helpers.ts";

type FixtureContext = {
  rootDir: string;
  tempRoot: string;
  workspaceDir: string;
  fakeBinDir: string;
  port: number;
  baseUrl: string;
  server: ChildProcess;
  env: NodeJS.ProcessEnv;
};

const test = base.extend<{ ctx: FixtureContext }>({
  ctx: async ({}, use) => {
    await using ctx = await createContext();
    await use(ctx);
  },
});

test("shows a page-load toast on each full document load", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await expect(page.getByTestId("page-load-toast")).toContainText("Page loaded #1");

  await page.reload();
  await expect(page.getByTestId("page-load-toast")).toContainText("Page loaded #2");
});

test("launches a TUI, translates boxes into semantic sections, and accepts composer input", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("semantic-agent");
  await expect(page.getByRole("textbox", { name: "Working directory" })).toHaveValue(fs.realpathSync(ctx.workspaceDir));
  await page.getByRole("button", { name: "Launch" }).click();

  await expect(page).toHaveURL(/\/sessions\/tuiui_[a-f0-9]+$/);
  await expect.poll(async () => (await fetchSessionPayload(page)).cols).not.toBe(120);
  const resizedPayload = await fetchSessionPayload(page);
  expect(resizedPayload.cols).toBeGreaterThanOrEqual(40);
  expect(resizedPayload.rows).toBeGreaterThanOrEqual(12);
  expect(countSerializedHtmlRows(resizedPayload.renderedHtml)).toBeLessThanOrEqual(resizedPayload.rows);
  await clickSessionMenuButton(page, "HTML");
  await expect(page.getByTestId("semantic-section").filter({ hasText: "Ask anything" })).toBeVisible();
  await expect(page.getByTestId("semantic-section").filter({ hasText: "semantic-agent" })).toBeVisible();

  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("semantic-section").filter({ hasText: "three" })).toBeVisible();
  await clickSessionMenuButton(page, "Summary");
  await expect(page.getByTestId("sdk-summary")).toContainText("No SDK adapter");
  await expect(page.getByTestId("tuishot-preview").locator("img")).toBeVisible();
  await expect.poll(async () => {
    return await page.getByTestId("tuishot-preview").locator("img").evaluate((image: HTMLImageElement) => {
      return image.complete && image.naturalWidth > 0;
    });
  }).toBe(true);
  await clickSessionMenuButton(page, "TTY");
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  const shot = await fetchTuishot(page);
  expect(shot.contentType).toContain("image/svg+xml");
  expect(shot.disposition).toContain("inline");
  expect(shot.body).toContain("<svg");
  expect(shot.body).toContain("semantic-agent");
  expect(shot.body).toContain("three");

  await clickSessionMenuButton(page, "Logs");
  await expect(page.getByTestId("stdin-log")).toContainText("what is one plus two");
  await expect(page.getByTestId("stdout-log")).toContainText("three");
});

test("exposes real and fake launcher presets as one-click button rows", async ({ page, ctx }) => {
  writeRecentOpenCodeFixtureState(ctx, {
    sessionId: "mobile-opencode-session",
    title: "OpenCode handoff session",
    latestUserText: "resume opencode from phone",
    latestAssistantText: "adding OpenCode recent buttons",
    messageAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  });
  writeRecentCodexFixtureState(ctx, {
    threadId: "mobile-codex-thread",
    title: "Phone handoff session",
    latestUserText: "connect to this very session from my phone",
    latestAssistantText: "adding recent Codex buttons",
    messageAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  writeRecentClaudeFixtureState(ctx, {
    sessionId: "00000000-0000-4000-8000-000000000456",
    title: "Claude handoff session",
    latestUserText: "resume claude from phone",
    latestAssistantText: "adding Claude recent buttons",
    messageAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  });

  await page.goto(ctx.baseUrl);

  await expect(page.getByRole("combobox", { name: "Preset" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Real presets" }).getByRole("button", { name: "Claude", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Fake presets" }).getByRole("button", { name: "Fake Claude", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume OpenCode session OpenCode handoff session/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume Claude session Claude handoff session/ })).toBeVisible();
  await expect(page.locator(".provider-pill", { hasText: "Codex" })).toBeVisible();
  await expect(page.locator(".provider-pill", { hasText: "OpenCode" })).toBeVisible();
  await expect(page.locator(".provider-pill", { hasText: "Claude" })).toBeVisible();

  const rows = await page.locator(".quick-launch-row").evaluateAll((elements) => {
    return elements.map((element) => ({
      label: element.querySelector(".quick-launch-label")?.textContent?.trim(),
      buttons: [...element.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    }));
  });
  expect(rows).toMatchObject([
    { label: "Real", buttons: ["OpenCode", "Codex", "Claude", "ghui"] },
    { label: "Fake", buttons: ["OpenCode", "Codex", "Claude"] },
  ]);

  await page.getByRole("button", { name: /Resume Codex session Phone handoff session/ }).click();
  await expect(page).toHaveURL(/\/sessions\/tuiui_[a-f0-9]+$/);
  const payload = await fetchSessionPayload(page);
  expect(payload).toMatchObject({
    command: "codex",
    args: ["resume", "mobile-codex-thread"],
    cwd: ctx.workspaceDir,
  });
});

test("sends named key chords separately from the composer", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("semantic-agent");
  await page.getByRole("button", { name: "Launch" }).click();
  await clickSessionMenuButton(page, "HTML");
  await expect(page.getByTestId("semantic-section").filter({ hasText: "Ask anything" })).toBeVisible();

  await page.getByRole("button", { name: "esc" }).click();

  await expect(page.getByTestId("semantic-section").filter({ hasText: "key escape" })).toBeVisible();
});

test("key chord buttons do not return focus to the composer", async ({ page, ctx }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("semantic-agent");
  await page.getByRole("button", { name: "Launch" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("Ask anything");

  const composer = page.getByRole("textbox", { name: "Send stdin" });
  await composer.focus();
  await expect(composer).toBeFocused();
  await page.getByRole("button", { name: "esc" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("key escape");
  expect(await composer.evaluate((element) => document.activeElement === element)).toBe(false);
});

test("can type directly into the terminal renderer", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("semantic-agent");
  await page.getByRole("button", { name: "Launch" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("Ask anything");

  await page.locator(".terminal-host").click();
  await page.keyboard.type("what is one plus two");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  const payload = await fetchSessionPayload(page);
  expect(payload.renderedAnsi).toContain("three");

  await page.reload();
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
});

test("keeps the terminal shell fixed while xterm owns scrolling", async ({ page, ctx }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("semantic-agent");
  await page.getByRole("button", { name: "Launch" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("Ask anything");

  await expect.poll(async () => {
    return await page.locator("#screen").evaluate((screen) => {
      const style = getComputedStyle(screen);
      return {
        overflowY: style.overflowY,
        outerVerticalScroll: screen.scrollHeight > screen.clientHeight + 1,
        outerHorizontalScroll: screen.scrollWidth > screen.clientWidth + 1,
      };
    });
  }).toMatchObject({
    overflowY: "hidden",
    outerVerticalScroll: false,
    outerHorizontalScroll: false,
  });

  const scrollTop = await page.locator("#screen").evaluate((screen) => {
    screen.scrollTop = 100;
    return screen.scrollTop;
  });
  expect(scrollTop).toBe(0);
});

test("keeps mobile session chrome compact without document scrolling", async ({ page, ctx }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("scrollback-agent");
  await page.getByRole("button", { name: "Launch" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("scrollback line 80");
  await expect(page.getByTestId("page-load-toast")).toBeVisible();
  const toastPlacement = await page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>("[data-testid='page-load-toast']")!.getBoundingClientRect();
    const menu = document.querySelector<HTMLElement>(".menu-button")!.getBoundingClientRect();
    return {
      toastLeft: toast.left,
      toastRight: toast.right,
      toastTop: toast.top,
      menuBottom: menu.bottom,
      intersectsMenu: !(toast.right < menu.left || toast.left > menu.right || toast.bottom < menu.top || toast.top > menu.bottom),
    };
  });
  expect(toastPlacement.toastLeft).toBeGreaterThanOrEqual(8);
  expect(toastPlacement.toastRight).toBeLessThanOrEqual(390 - 8);
  expect(toastPlacement.toastTop).toBeGreaterThanOrEqual(toastPlacement.menuBottom);
  expect(toastPlacement.intersectsMenu).toBe(false);
  await expect(page.getByRole("button", { name: "Send" })).toContainText("↵");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const app = document.getElementById("app")!;
      const screen = document.getElementById("screen")!;
      const terminalViewport = document.querySelector<HTMLElement>(".xterm-viewport");
      return {
        documentScrolls: doc.scrollHeight > doc.clientHeight + 1,
        bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        appScrolls: app.scrollHeight > app.clientHeight + 1,
        horizontalScrolls: doc.scrollWidth > doc.clientWidth + 1,
        screenOverflowY: getComputedStyle(screen).overflowY,
        terminalOwnsScroll: Boolean(terminalViewport && getComputedStyle(terminalViewport).overflowY === "auto"),
      };
    });
  }).toMatchObject({
    documentScrolls: false,
    bodyScrolls: false,
    appScrolls: false,
    horizontalScrolls: false,
    screenOverflowY: "hidden",
    terminalOwnsScroll: true,
  });

  await expect(page.getByRole("button", { name: "Scroll terminal up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scroll terminal down" })).toBeVisible();
  const terminalRowsBefore = await page.locator(".xterm-rows").textContent();
  await page.getByRole("button", { name: "Scroll terminal up" }).click();
  let terminalRowsAfterUp = "";
  await expect.poll(async () => {
    terminalRowsAfterUp = await page.locator(".xterm-rows").textContent() || "";
    return terminalRowsAfterUp;
  }).not.toBe(terminalRowsBefore);
  expect(terminalRowsAfterUp).toContain("scrollback line 70");
  expect(terminalRowsAfterUp).not.toContain("scrollback line 07");
  await page.getByRole("button", { name: "Scroll terminal down" }).click();
  await expect.poll(async () => {
    return await page.locator(".xterm-rows").textContent();
  }).toBe(terminalRowsBefore);

  const chrome = await page.evaluate(() => {
    return {
      appbarBorder: getComputedStyle(document.querySelector<HTMLElement>(".session-appbar")!).borderBottomWidth,
      screenBorderTop: getComputedStyle(document.querySelector<HTMLElement>(".screen")!).borderTopWidth,
      screenBorderBottom: getComputedStyle(document.querySelector<HTMLElement>(".screen")!).borderBottomWidth,
      composerBorder: getComputedStyle(document.querySelector<HTMLElement>(".composer")!).borderTopWidth,
      screenTouchAction: getComputedStyle(document.querySelector<HTMLElement>(".screen")!).touchAction,
      scrollButtonTouchAction: getComputedStyle(document.querySelector<HTMLElement>(".terminal-scroll-button")!).touchAction,
      terminalFontSize: getComputedStyle(document.querySelector<HTMLElement>(".terminal-xterm-wrap")!).fontSize,
      textareaFontSize: getComputedStyle(document.querySelector<HTMLElement>("textarea")!).fontSize,
      textareaTouchAction: getComputedStyle(document.querySelector<HTMLElement>("textarea")!).touchAction,
    };
  });
  expect(chrome).toMatchObject({
    appbarBorder: "0px",
    screenBorderTop: "0px",
    screenBorderBottom: "0px",
    composerBorder: "0px",
    screenTouchAction: "manipulation",
    scrollButtonTouchAction: "manipulation",
    terminalFontSize: "12px",
    textareaFontSize: "16px",
    textareaTouchAction: "manipulation",
  });

  const keyMetrics = await page.locator(".keys").evaluate((keys) => {
    const visibleBoxes = [...keys.querySelectorAll<HTMLElement>(".key-button:not(.overflow-key), .key-more")]
      .filter((button) => getComputedStyle(button).display !== "none")
      .map((button) => button.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const tops = visibleBoxes.map((box) => box.top);
    return {
      visibleButtonCount: visibleBoxes.length,
      topSpread: Math.max(...tops) - Math.min(...tops),
      hasOverflowMenu: getComputedStyle(keys.querySelector<HTMLElement>(".key-overflow")!).display !== "none",
    };
  });
  expect(keyMetrics).toMatchObject({
    visibleButtonCount: 5,
    hasOverflowMenu: true,
  });
  expect(keyMetrics.topSpread).toBeLessThan(2);

  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "TTY" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Summary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "HTML" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause events" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Logs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.locator(".menu-fact code")).toHaveText(fs.realpathSync(ctx.workspaceDir));
});

test("can pause and resume live session events", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("semantic-agent");
  await page.getByRole("button", { name: "Launch" }).click();
  await clickSessionMenuButton(page, "Pause events");

  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "Resume events" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("rendered-terminal")).not.toContainText("three");

  await clickSessionMenuButton(page, "Resume events");

  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "Pause events" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
});

test("keeps split utf-8 output intact", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("bytewise-ui");
  await page.getByRole("button", { name: "Launch" }).click();

  await expect(page.getByTestId("semantic-screen")).toContainText("──hello──");
  await expect(page.getByTestId("semantic-screen")).not.toContainText("\uFFFD");
});

test("does not inherit NO_COLOR into launched TUIs", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("color-env-agent");
  await page.getByRole("button", { name: "Launch" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("colored");
  const payload = await fetchSessionPayload(page);
  expect(payload.stdoutEvents[0]).toMatchObject({
    chunk: expect.stringContaining("\u001b[31mcolored"),
  });
});

test("does not let package-manager bin shims shadow real agent commands", async ({ page }) => {
  await using ctx = await createContextWithCodexShimShadow();

  await page.goto(ctx.baseUrl);
  await page.getByRole("button", { name: "Codex", exact: true }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("Codex test TUI");
  await expect(page.getByTestId("rendered-terminal")).not.toContainText("shadowed repo-local codex");
});

test("can drive OpenCode through fakeagent when OpenCode is installed", async ({ page, ctx }) => {
  test.skip(!commandExists("opencode"), "opencode is not installed");

  await page.goto(ctx.baseUrl);
  await page.getByRole("button", { name: "Fake OpenCode" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText(/Ask anything|OpenCode/i);

  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("three", { timeout: 20_000 });
  await clickSessionMenuButton(page, "Summary");
  await page.getByRole("button", { name: "Refresh snapshot" }).click();
  await expect(page.getByTestId("sdk-summary")).toContainText("connected");
  await expect(page.getByTestId("session-brief")).toContainText("No session brief yet.");
  await expect(page.locator(".sdk-diagnostics")).not.toHaveAttribute("open", "");
  await openSdkDiagnostics(page);
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("latestUserText: what is one plus two");
  await expect(page.locator("#sdk-yaml-editor .cm-line span[class]").first()).toBeVisible();
  expect(await measureFirstLineGutterOffset(page)).toBeLessThanOrEqual(1);
  const refreshedPayload = await fetchSessionPayload(page);
  expect(refreshedPayload.sdk.summary.latestAssistantText).toContain("three");
  await page.getByRole("button", { name: "Get session brief" }).click();
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("method: opencode.session.fork+summarize", { timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("status: completed");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("forks:");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("forkSessionId:");
  await expect(page.getByTestId("session-brief")).toContainText("current");
  await expect.poll(async () => (await page.getByTestId("session-brief").locator("pre").textContent())?.trim()).not.toBe("No session brief yet.");
  const payload = await fetchSessionPayload(page);
  expect(payload.sdk.forks[0]).toMatchObject({
    provider: "opencode",
    purpose: "sidecarSummary",
    sourceSessionId: payload.sdk.externalSessionId,
    forkPoint: payload.sdk.summary.forkPoint,
    status: "summarized",
    result: true,
  });
  expect(payload.sdk.forks[0].forkSessionId).not.toBe(payload.sdk.externalSessionId);
  expect(payload.sdk.summary).toMatchObject({ messageCount: 2 });
  await page.getByRole("button", { name: "Get session brief" }).click();
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("Reused the completed session brief for the current fork point.");
  const reusedPayload = await fetchSessionPayload(page);
  expect(reusedPayload.sdk.forks).toHaveLength(1);
  expect(reusedPayload.sdk.forks[0].forkSessionId).toBe(payload.sdk.forks[0].forkSessionId);
  const yamlBeforeRefresh = await page.locator("#sdk-yaml-editor .cm-content").textContent();
  const scrollBeforeRefresh = await scrollYamlEditorToBottom(page);
  await markYamlEditorContent(page);
  await page.getByRole("button", { name: "Refresh snapshot" }).click();
  await expect.poll(async () => await page.locator("#sdk-yaml-editor .cm-content").textContent()).not.toBe(yamlBeforeRefresh);
  expect(await isYamlEditorContentMarked(page)).toBe(true);
  expect(await getYamlEditorScrollTop(page)).toBeGreaterThanOrEqual(scrollBeforeRefresh - 1);
  await expect(page.locator("#sdk-yaml-editor .cm-foldGutter span[title='Fold line']").first()).toBeVisible();
  await expect(page.locator("#sdk-yaml-editor .cm-editor.cm-lineWrapping")).toHaveCount(0);
});

test("resolves a fakeagent-backed Codex TUI into SDK summary YAML", async ({ page, ctx }) => {
  const fakeCodexHome = "/tmp/fakeagent-codex-home";
  fs.rmSync(fakeCodexHome, { recursive: true, force: true });

  await page.goto(ctx.baseUrl);
  const commands = await page.evaluate(async () => await fetch("/api/commands").then((response) => response.json()));
  expect(commands).toContainEqual(expect.objectContaining({
    id: "codex",
    command: "codex",
    fakeAgent: "",
  }));
  expect(commands).toContainEqual(expect.objectContaining({
    id: "fake-codex",
    command: "codex",
    fakeAgent: "codex",
  }));
  await expect(page.getByRole("combobox", { name: "Preset" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "OpenCode", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fake Codex" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("Codex test TUI");
  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  const launchedPayload = await fetchSessionPayload(page);
  writeCodexFixtureState(ctx, launchedPayload.createdAt, {
    codexHomeDir: path.join(ctx.env.HOME || "", ".codex"),
    threadId: "this-tuiui-development-session",
    title: "Supervising Codex session",
    latestUserText: "fix the tuiui summary tab",
    latestAssistantText: "this is the wrong supervising session",
    createdOffsetMs: -60_000,
    updatedOffsetMs: 2_000,
  });
  writeCodexFixtureState(ctx, launchedPayload.createdAt, {
    codexHomeDir: fakeCodexHome,
    threadId: "codex-test-thread",
    title: "Codex fixture thread",
    latestUserText: "summarize this codex tui",
    latestAssistantText: "codex can now be summarized",
    createdOffsetMs: 100,
    updatedOffsetMs: 1_000,
  });

  await clickSessionMenuButton(page, "Summary");
  await page.getByRole("button", { name: "Refresh snapshot" }).click();

  await expect(page.getByTestId("sdk-summary")).toContainText("connected");
  await openSdkDiagnostics(page);
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("provider: codex");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("baseUrl: /tmp/fakeagent-codex-home/state_5.sqlite");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("providerSessionId: codex-test-thread");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("latestUserText: summarize this codex tui");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("latestAssistantText: codex can now be summarized");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).not.toContainText("this is the wrong supervising session");
  await expect.poll(async () => {
    return await page.locator("#sdk-yaml-editor .cm-editor").evaluate((editor) => getComputedStyle(editor).fontSize);
  }).toBe("10px");

  const payload = await fetchSessionPayload(page);
  expect(payload.sdk.summary).toMatchObject({
    provider: "codex",
    latestUserText: "summarize this codex tui",
    latestAssistantText: "codex can now be summarized",
  });
});

test("shows a toast instead of an unhandled rejection when session brief fetch fails", async ({ page, ctx }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(ctx.baseUrl);
  await page.getByRole("button", { name: "Fake Codex" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("Codex test TUI");
  await clickSessionMenuButton(page, "Summary");
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    (window as any).fetch = (input: any, init: any) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/sdk-summarize")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return realFetch(input, init);
    };
  });

  await page.getByRole("button", { name: "Get session brief" }).click();

  await expect(page.getByTestId("sdk-summarize-error-toast")).toContainText("Get session brief failed");
  expect(pageErrors).toEqual([]);
});

test("can drive Claude through the fake preset", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);
  await page.getByRole("button", { name: "Fake Claude" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("Claude test TUI");
  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  const payload = await fetchSessionPayload(page);
  expect(payload).toMatchObject({
    command: "claude",
    sdk: {
      provider: "claude",
      state: "ready",
    },
  });
});

async function fetchSessionPayload(page: Page) {
  return await page.evaluate(async () => {
    const id = location.pathname.split("/").at(-1);
    return await fetch(`/api/sessions/${id}`).then((response) => response.json());
  });
}

async function fetchTuishot(page: Page) {
  return await page.evaluate(async () => {
    const id = location.pathname.split("/").at(-1);
    const response = await fetch(`/api/sessions/${id}/tuishot.svg`);
    return {
      contentType: response.headers.get("content-type") || "",
      disposition: response.headers.get("content-disposition") || "",
      body: await response.text(),
    };
  });
}

async function clickSessionMenuButton(page: Page, name: string) {
  await openSessionMenu(page);
  await page.getByRole("button", { name }).click();
}

async function openSessionMenu(page: Page) {
  const menu = page.locator(".session-menu");
  if ((await menu.getAttribute("open")) !== null) {
    return;
  }
  await page.getByRole("button", { name: "Session menu" }).click();
}

async function openSdkDiagnostics(page: Page) {
  const diagnostics = page.locator(".sdk-diagnostics");
  if ((await diagnostics.getAttribute("open")) !== null) {
    return;
  }
  await page.locator(".sdk-diagnostics > summary").click();
}

async function measureFirstLineGutterOffset(page: Page) {
  return await page.locator("#sdk-yaml-editor").evaluate((editor) => {
    const line = editor.querySelector(".cm-line");
    const lineNumber = [...editor.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
      .find((element) => element.textContent?.trim() === "1");
    if (!line || !lineNumber) {
      return 999;
    }
    const lineBox = line.getBoundingClientRect();
    const gutterBox = lineNumber.getBoundingClientRect();
    const lineCenter = lineBox.top + lineBox.height / 2;
    const gutterCenter = gutterBox.top + gutterBox.height / 2;
    return Math.abs(lineCenter - gutterCenter);
  });
}

async function scrollYamlEditorToBottom(page: Page) {
  return await page.locator("#sdk-yaml-editor .cm-scroller").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
    return scroller.scrollTop;
  });
}

async function getYamlEditorScrollTop(page: Page) {
  return await page.locator("#sdk-yaml-editor .cm-scroller").evaluate((scroller) => scroller.scrollTop);
}

async function markYamlEditorContent(page: Page) {
  await page.locator("#sdk-yaml-editor").evaluate((editor) => {
    (editor.querySelector(".cm-content") as any).__tuiuiStillMounted = true;
  });
}

async function isYamlEditorContentMarked(page: Page) {
  return await page.locator("#sdk-yaml-editor").evaluate((editor) => {
    return Boolean((editor.querySelector(".cm-content") as any).__tuiuiStillMounted);
  });
}

function countSerializedHtmlRows(html: string) {
  return html.match(/<div><span>/g)?.length || 0;
}

async function createContext() {
  return await createContextWithPathPrefix("");
}

async function createContextWithCodexShimShadow() {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-codex-shadow-"));
  const shadowBinDir = path.join(shadowRoot, "node_modules", ".bin");
  fs.mkdirSync(shadowBinDir, { recursive: true });
  fs.writeFileSync(path.join(shadowBinDir, "codex"), `#!/usr/bin/env node
process.stdout.write("shadowed repo-local codex\\n");
setTimeout(() => process.exit(0), 100);
`, { mode: 0o755 });
  const ctx = await createContextWithPathPrefix(shadowBinDir);
  return {
    ...ctx,
    async [Symbol.asyncDispose]() {
      await ctx[Symbol.asyncDispose]();
      fs.rmSync(shadowRoot, { recursive: true, force: true });
    },
  };
}

async function createContextWithPathPrefix(pathPrefix: string) {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-spec-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const fakeBinDir = path.join(tempRoot, "bin");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(path.join(fakeBinDir, "semantic-agent"), semanticAgentSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "bytewise-ui"), bytewiseUiSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "color-env-agent"), colorEnvAgentSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "scrollback-agent"), scrollbackAgentSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "codex"), codexTuiSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "claude"), claudeTuiSource, { mode: 0o755 });

  const port = await getFreePort();
  const pathParts = [pathPrefix, fakeBinDir, process.env.PATH || ""].filter(Boolean);
  const env = {
    ...process.env,
    PATH: pathParts.join(path.delimiter),
    HOME: path.join(tempRoot, "home"),
    NO_COLOR: "1",
  };
  const server = spawn("bun", ["run", path.join(rootDir, "cli.ts"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: workspaceDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForServer(server, port);

  return {
    rootDir,
    tempRoot,
    workspaceDir,
    fakeBinDir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    env,
    async [Symbol.asyncDispose]() {
      server.kill("SIGTERM");
      await Promise.race([
        once(server, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1_500)),
      ]);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function waitForServer(server: ChildProcess, port: number) {
  let stdout = "";
  let stderr = "";
  server.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
    }
    if (server.exitCode !== null) {
      throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for server\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function commandExists(command: string) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  return paths.some((dir) => fs.existsSync(path.join(dir, command)));
}

const semanticAgentSource = `#!/usr/bin/env node
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let input = "";
let answer = "";
let key = "";

function draw() {
  process.stdout.write("\\x1b[2J\\x1b[H");
  process.stdout.write("╭─ semantic-agent ─────────────╮\\r\\n");
  process.stdout.write("│ status idle                  │\\r\\n");
  process.stdout.write("╰──────────────────────────────╯\\r\\n");
  process.stdout.write("\\r\\n");
  process.stdout.write("╭─ Ask anything ───────────────╮\\r\\n");
  process.stdout.write(("│ " + (input || " ") + "                              │").slice(0, 32) + "│\\r\\n");
  process.stdout.write("╰──────────────────────────────╯\\r\\n");
  if (answer) {
    process.stdout.write("\\r\\n╭─ Answer ─────────────────────╮\\r\\n");
    process.stdout.write(("│ " + answer + "                              │").slice(0, 32) + "│\\r\\n");
    process.stdout.write("╰──────────────────────────────╯\\r\\n");
  }
  if (key) {
    process.stdout.write("\\r\\n╭─ Key ────────────────────────╮\\r\\n");
    process.stdout.write(("│ " + key + "                              │").slice(0, 32) + "│\\r\\n");
    process.stdout.write("╰──────────────────────────────╯\\r\\n");
  }
}

function submit() {
  answer = /one plus two/i.test(input) ? "three" : "heard " + input;
  input = "";
  draw();
}

draw();

process.stdin.on("data", (chunk) => {
  for (const char of chunk) {
    if (char === "\\u0003") process.exit(0);
    if (char === "\\u001b") {
      key = "key escape";
      draw();
      continue;
    }
    if (char === "\\r" || char === "\\n") {
      submit();
      continue;
    }
    input += char;
  }
  draw();
});
`;

const bytewiseUiSource = `#!/usr/bin/env node
const bytes = Buffer.from("──hello──\\n", "utf8");
let index = 0;

function tick() {
  if (index >= bytes.length) return;
  process.stdout.write(Buffer.from([bytes[index]]));
  index += 1;
  setTimeout(tick, 5);
}

tick();
setTimeout(() => {}, 100000);
`;

const colorEnvAgentSource = `#!/usr/bin/env node
if (process.env.NO_COLOR) {
  process.stdout.write("plain\\n");
} else {
  process.stdout.write("\\x1b[31mcolored\\x1b[0m\\n");
}
setTimeout(() => {}, 100000);
`;

const scrollbackAgentSource = `#!/usr/bin/env node
for (let index = 1; index <= 80; index += 1) {
  process.stdout.write("scrollback line " + String(index).padStart(2, "0") + "\\r\\n");
}
setTimeout(() => {}, 100000);
`;

function writeCodexFixtureState(
  ctx: FixtureContext,
  launchedAt: string,
  options: {
    codexHomeDir: string;
    threadId: string;
    title: string;
    latestUserText: string;
    latestAssistantText: string;
    createdOffsetMs: number;
    updatedOffsetMs: number;
  },
) {
  const codexDir = options.codexHomeDir;
  const sessionsDir = path.join(codexDir, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = path.join(sessionsDir, `rollout-${options.threadId}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    codexRolloutMessage("2026-05-08T14:28:02.000Z", "user", options.latestUserText),
    codexRolloutMessage("2026-05-08T14:28:03.000Z", "assistant", options.latestAssistantText),
  ].join("\n"));

  const databasePath = path.join(options.codexHomeDir, "state_5.sqlite");
  const createdAtMs = new Date(launchedAt).getTime() + options.createdOffsetMs;
  const updatedAtMs = new Date(launchedAt).getTime() + options.updatedOffsetMs;
  execFileSync("sqlite3", [databasePath, `
    create table if not exists threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      source text not null,
      model_provider text not null,
      cwd text not null,
      title text not null,
      sandbox_policy text not null,
      approval_mode text not null,
      tokens_used integer not null default 0,
      has_user_event integer not null default 0,
      archived integer not null default 0,
      archived_at integer,
      git_sha text,
      git_branch text,
      git_origin_url text,
      cli_version text not null default '',
      first_user_message text not null default '',
      agent_nickname text,
      agent_role text,
      memory_mode text not null default 'enabled',
      model text,
      reasoning_effort text,
      agent_path text,
      created_at_ms integer,
      updated_at_ms integer,
      thread_source text
    );
    insert or replace into threads (
      id,
      rollout_path,
      created_at,
      updated_at,
      source,
      model_provider,
      cwd,
      title,
      sandbox_policy,
      approval_mode,
      tokens_used,
      has_user_event,
      archived,
      cli_version,
      first_user_message,
      memory_mode,
      model,
      reasoning_effort,
      created_at_ms,
      updated_at_ms
    ) values (
      '${sqlString(options.threadId)}',
      '${sqlString(rolloutPath)}',
      ${Math.floor(createdAtMs / 1000)},
      ${Math.floor(updatedAtMs / 1000)},
      'cli',
      'openai',
      '${sqlString(ctx.workspaceDir)}',
      '${sqlString(options.title)}',
      'read-only',
      'never',
      42,
      1,
      0,
      '0.129.0',
      '${sqlString(options.latestUserText)}',
      'enabled',
      'gpt-5.5',
      'medium',
      ${createdAtMs},
      ${updatedAtMs}
    );
  `]);
}

function writeRecentCodexFixtureState(
  ctx: FixtureContext,
  options: {
    threadId: string;
    title: string;
    latestUserText: string;
    latestAssistantText: string;
    messageAt: string;
  },
) {
  const codexDir = path.join(ctx.env.HOME || "", ".codex");
  const sessionsDir = path.join(codexDir, "sessions", "2026", "05", "11");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = path.join(sessionsDir, `rollout-${options.threadId}.jsonl`);
  const messageAtMs = new Date(options.messageAt).getTime();
  fs.writeFileSync(rolloutPath, [
    codexRolloutMessage(new Date(messageAtMs - 1_000).toISOString(), "user", options.latestUserText),
    codexRolloutMessage(options.messageAt, "assistant", options.latestAssistantText),
  ].join("\n"));

  const databasePath = path.join(codexDir, "state_5.sqlite");
  execFileSync("sqlite3", [databasePath, `
    create table if not exists threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      source text not null,
      model_provider text not null,
      cwd text not null,
      title text not null,
      sandbox_policy text not null,
      approval_mode text not null,
      tokens_used integer not null default 0,
      has_user_event integer not null default 0,
      archived integer not null default 0,
      archived_at integer,
      git_sha text,
      git_branch text,
      git_origin_url text,
      cli_version text not null default '',
      first_user_message text not null default '',
      agent_nickname text,
      agent_role text,
      memory_mode text not null default 'enabled',
      model text,
      reasoning_effort text,
      agent_path text,
      created_at_ms integer,
      updated_at_ms integer,
      thread_source text
    );
    insert or replace into threads (
      id,
      rollout_path,
      created_at,
      updated_at,
      source,
      model_provider,
      cwd,
      title,
      sandbox_policy,
      approval_mode,
      tokens_used,
      has_user_event,
      archived,
      cli_version,
      first_user_message,
      memory_mode,
      model,
      reasoning_effort,
      created_at_ms,
      updated_at_ms
    ) values (
      '${sqlString(options.threadId)}',
      '${sqlString(rolloutPath)}',
      ${Math.floor((messageAtMs - 5_000) / 1000)},
      ${Math.floor(messageAtMs / 1000)},
      'cli',
      'openai',
      '${sqlString(ctx.workspaceDir)}',
      '${sqlString(options.title)}',
      'read-only',
      'never',
      42,
      1,
      0,
      '0.129.0',
      '${sqlString(options.latestUserText)}',
      'enabled',
      'gpt-5.5',
      'medium',
      ${messageAtMs - 5_000},
      ${messageAtMs}
    );
  `]);
}

function writeRecentOpenCodeFixtureState(
  ctx: FixtureContext,
  options: {
    sessionId: string;
    title: string;
    latestUserText: string;
    latestAssistantText: string;
    messageAt: string;
  },
) {
  const databasePath = path.join(ctx.env.HOME || "", ".local", "share", "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const messageAtMs = new Date(options.messageAt).getTime();
  const userMessageId = `${options.sessionId}-user`;
  const assistantMessageId = `${options.sessionId}-assistant`;
  execFileSync("sqlite3", [databasePath, `
    create table if not exists session (
      id text primary key,
      directory text not null,
      title text not null,
      version text not null default '',
      time_created integer not null,
      time_updated integer not null,
      time_archived integer
    );
    create table if not exists message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
    create table if not exists part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
    insert or replace into session (
      id, directory, title, version, time_created, time_updated, time_archived
    ) values (
      '${sqlString(options.sessionId)}',
      '${sqlString(ctx.workspaceDir)}',
      '${sqlString(options.title)}',
      '1.0.0',
      ${messageAtMs - 5_000},
      ${messageAtMs},
      null
    );
    insert or replace into message (
      id, session_id, time_created, time_updated, data
    ) values (
      '${sqlString(userMessageId)}',
      '${sqlString(options.sessionId)}',
      ${messageAtMs - 1_000},
      ${messageAtMs - 1_000},
      '${sqlString(JSON.stringify({ role: "user" }))}'
    );
    insert or replace into message (
      id, session_id, time_created, time_updated, data
    ) values (
      '${sqlString(assistantMessageId)}',
      '${sqlString(options.sessionId)}',
      ${messageAtMs},
      ${messageAtMs},
      '${sqlString(JSON.stringify({ role: "assistant" }))}'
    );
    insert or replace into part (
      id, message_id, session_id, time_created, time_updated, data
    ) values (
      '${sqlString(`${userMessageId}-text`)}',
      '${sqlString(userMessageId)}',
      '${sqlString(options.sessionId)}',
      ${messageAtMs - 1_000},
      ${messageAtMs - 1_000},
      '${sqlString(JSON.stringify({ type: "text", text: options.latestUserText }))}'
    );
    insert or replace into part (
      id, message_id, session_id, time_created, time_updated, data
    ) values (
      '${sqlString(`${assistantMessageId}-text`)}',
      '${sqlString(assistantMessageId)}',
      '${sqlString(options.sessionId)}',
      ${messageAtMs},
      ${messageAtMs},
      '${sqlString(JSON.stringify({ type: "text", text: options.latestAssistantText }))}'
    );
  `]);
}

function writeRecentClaudeFixtureState(
  ctx: FixtureContext,
  options: {
    sessionId: string;
    title: string;
    latestUserText: string;
    latestAssistantText: string;
    messageAt: string;
  },
) {
  const claudeDir = path.join(ctx.env.HOME || "", ".claude", "projects", ctx.workspaceDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(claudeDir, { recursive: true });
  const messageAtMs = new Date(options.messageAt).getTime();
  fs.writeFileSync(path.join(claudeDir, `${options.sessionId}.jsonl`), [
    JSON.stringify({
      type: "custom-title",
      customTitle: options.title,
      uuid: "00000000-0000-4000-8000-000000000101",
      sessionId: options.sessionId,
      cwd: ctx.workspaceDir,
      timestamp: new Date(messageAtMs - 2_000).toISOString(),
    }),
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000102",
      sessionId: options.sessionId,
      cwd: ctx.workspaceDir,
      timestamp: new Date(messageAtMs - 1_000).toISOString(),
      message: { role: "user", content: options.latestUserText },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000103",
      sessionId: options.sessionId,
      cwd: ctx.workspaceDir,
      timestamp: options.messageAt,
      message: {
        role: "assistant",
        content: [{ type: "text", text: options.latestAssistantText }],
      },
    }),
  ].join("\n"));
}

function codexRolloutMessage(timestamp: string, role: string, text: string) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{
        type: role === "assistant" ? "output_text" : "input_text",
        text,
      }],
    },
  });
}

function sqlString(value: string) {
  return value.replaceAll("'", "''");
}

const codexTuiSource = `#!/usr/bin/env node
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let input = "";
let sawLineFeed = false;
let answer = "";

function draw() {
  process.stdout.write("\\x1b[2J\\x1b[H");
  process.stdout.write("\\x1b[36m╭─ Codex test TUI ─────────────╮\\x1b[0m\\r\\n");
  process.stdout.write("\\x1b[36m│\\x1b[0m status idle                  \\x1b[36m│\\x1b[0m\\r\\n");
  process.stdout.write("╰──────────────────────────────╯\\r\\n");
  process.stdout.write("\\r\\n");
  process.stdout.write(("› " + input + "                              ").slice(0, 32) + "\\r\\n");
  if (answer) {
    process.stdout.write("\\x1b[32m" + answer + "\\x1b[0m\\r\\n");
  }
}

draw();
process.stdin.on("data", (chunk) => {
  for (const char of chunk) {
    if (char === "\\u0003") process.exit(0);
    if (char === "\\n") {
      sawLineFeed = true;
      continue;
    }
    if (char === "\\r") {
      if (sawLineFeed && input.trim()) {
        answer = /one plus two/i.test(input) ? "three" : "heard " + input;
        input = "";
      }
      sawLineFeed = false;
      continue;
    }
    input += char;
  }
  draw();
});
`;

const claudeTuiSource = `#!/usr/bin/env node
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let input = "";
let answer = "";

function draw() {
  process.stdout.write("\\x1b[2J\\x1b[H");
  process.stdout.write("\\x1b[35m╭─ Claude test TUI ────────────╮\\x1b[0m\\r\\n");
  process.stdout.write("\\x1b[35m│\\x1b[0m status idle                  \\x1b[35m│\\x1b[0m\\r\\n");
  process.stdout.write("╰──────────────────────────────╯\\r\\n");
  process.stdout.write("\\r\\n");
  process.stdout.write(("> " + input + "                              ").slice(0, 32) + "\\r\\n");
  if (answer) {
    process.stdout.write("\\x1b[32m" + answer + "\\x1b[0m\\r\\n");
  }
}

draw();
process.stdin.on("data", (chunk) => {
  for (const char of chunk) {
    if (char === "\\u0003") process.exit(0);
    if (char === "\\r" || char === "\\n") {
      if (input.trim()) {
        answer = /one plus two/i.test(input) ? "three" : "heard " + input;
        input = "";
      }
      continue;
    }
    input += char;
  }
  draw();
});
`;
