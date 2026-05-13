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

test("does not show a page-load toast by default", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.waitForTimeout(200);
  await expect(page.getByTestId("page-load-toast")).toHaveCount(0);
});

test("shows a page-load toast on each full document load when opted in", async ({ page }) => {
  await using ctx = await createContext({ TUIUI_PAGE_LOAD_TOASTS: "1" });

  await page.goto(ctx.baseUrl);

  await expect(page.getByTestId("page-load-toast")).toContainText("Page loaded #1");

  await page.reload();
  await expect(page.getByTestId("page-load-toast")).toContainText("Page loaded #2");
});

test("requests idle notification permission only after the explicit control is clicked", async ({ page, ctx }) => {
  await page.addInitScript(() => {
    const notificationState = { requests: 0 };
    class TestNotification {
      static permission: NotificationPermission = "default";
      onclick: ((event: Event) => void) | null = null;

      constructor(_title: string, _options: NotificationOptions) {
      }

      static async requestPermission() {
        notificationState.requests += 1;
        TestNotification.permission = "granted";
        return TestNotification.permission;
      }

      close() {
      }
    }

    Object.defineProperty(window, "__tuiuiNotificationTest", {
      configurable: true,
      value: notificationState,
    });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: TestNotification,
    });
  });

  await page.goto(ctx.baseUrl);

  await expect(page.getByTestId("idle-notification-toggle")).toHaveText("Idle alerts: off");
  expect(await page.evaluate(() => (window as any).__tuiuiNotificationTest.requests)).toBe(0);

  await page.getByTestId("idle-notification-toggle").click();

  await expect(page.getByTestId("idle-notification-toggle")).toHaveText("Idle alerts: browser");
  expect(await page.evaluate(() => (window as any).__tuiuiNotificationTest.requests)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("tuiui-browser-idle-notifications-enabled"))).toBe("1");
});

test("does not poll home idle notification snapshots before opt in", async ({ page, ctx }) => {
  let jsonApiRequests = 0;
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith("/rpc")) {
      jsonApiRequests += 1;
    }
    await route.continue();
  });

  await page.goto(ctx.baseUrl);
  await expect(page.getByTestId("idle-notification-toggle")).toHaveText("Idle alerts: off");
  const requestsAfterInitialLoad = jsonApiRequests;
  expect(requestsAfterInitialLoad).toBeGreaterThan(0);

  await page.waitForTimeout(5_300);

  expect(jsonApiRequests).toBe(requestsAfterInitialLoad);
});

test("does not refresh busy session idle status before opt in", async ({ page, ctx }) => {
  const sessionId = "tuiui_idle_polling";
  let sessionRequests = 0;
  await page.route(`**/api/sessions/${sessionId}`, async (route) => {
    sessionRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fakeSessionPayload({ id: sessionId, status: "busy" })),
    });
  });
  await page.route(`**/api/sessions/${sessionId}/events`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    });
  });

  await page.goto(`${ctx.baseUrl}/sessions/${sessionId}`);
  await expect(page.getByTestId("session-status")).toHaveText("busy");
  expect(sessionRequests).toBe(1);

  await page.waitForTimeout(1_600);

  expect(sessionRequests).toBe(1);
});

test("shows a compact recovery command for a missing session", async ({ page, ctx }) => {
  await useLegacyApi(page);
  await page.route("**/api/sessions/tuiui_missing", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Session not found" }),
    });
  });
  await page.route("**/api/sessions/tuiui_missing/recovery", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "tuiui_missing",
        cwd: ctx.workspaceDir,
        launchCommand: "codex",
        createdAtMs: Date.now(),
        recoveryCommand: "codex resume abc123",
        recoveryCreatedAtMs: Date.now(),
        recoverable: true,
      }),
    });
  });

  await page.goto(`${ctx.baseUrl}/sessions/tuiui_missing`);

  await expect(page.locator(".missing-session")).toContainText("Session not found");
  await expect(page.locator(".missing-session")).not.toContainText("{\"error\"");
  await expect(page.getByRole("button", { name: "codex resume abc123" })).toBeVisible();
  await expect(page.locator(".missing-session-cwd")).toHaveText(ctx.workspaceDir);
  await expect(page.getByRole("link", { name: "Launch a new session" })).toHaveCount(0);
});

test("launches fake Codex, translates the TUI into semantic sections, and accepts composer input", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);
  expect((await fetchSessionPayload(page)).cwd).toBe(fs.realpathSync(ctx.workspaceDir));

  await expect.poll(async () => (await fetchSessionPayload(page)).cols).not.toBe(120);
  const resizedPayload = await fetchSessionPayload(page);
  expect(resizedPayload.cols).toBeGreaterThanOrEqual(40);
  expect(resizedPayload.rows).toBeGreaterThanOrEqual(12);
  expect(countSerializedHtmlRows(resizedPayload.renderedHtml)).toBeLessThanOrEqual(resizedPayload.rows);
  await clickSessionMenuButton(page, "HTML");
  await expect(page.getByTestId("semantic-screen")).toContainText("OpenAI Codex");

  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("semantic-screen")).toContainText("what is one plus two");
  await expect(page.getByTestId("semantic-screen")).toContainText("three");
  await clickSessionMenuButton(page, "Debug");
  await expect(page.getByTestId("sdk-debug")).toContainText(/ready|connected/i);
  await expect(page.getByTestId("tuishot-preview")).not.toHaveAttribute("open", "");
  await page.locator(".tuishot-preview > summary").click();
  await expect(page.getByTestId("tuishot-preview").locator("img")).toBeVisible();
  await expect.poll(async () => {
    return await page.getByTestId("tuishot-preview").locator("img").evaluate((image: HTMLImageElement) => {
      return image.complete && image.naturalWidth > 0;
    });
  }).toBe(true);
  await expect.poll(async () => {
    return await page.locator(".tuishot-frame").evaluate((frame: HTMLElement) => ({
      fitsWidth: frame.scrollWidth <= frame.clientWidth + 1,
      fitsHeight: frame.scrollHeight <= frame.clientHeight + 1,
    }));
  }).toMatchObject({ fitsWidth: true, fitsHeight: true });
  const tuishotLink = page.getByTestId("tuishot-preview").locator("[data-tuishot-link]");
  await expect(tuishotLink).toHaveAttribute("target", "_blank");
  const [tuishotPage] = await Promise.all([
    page.waitForEvent("popup"),
    tuishotLink.click(),
  ]);
  expect(tuishotPage.url()).toContain("/tuishot.svg");
  await tuishotPage.close();
  const sessionId = (await fetchSessionPayload(page)).id;
  await page.goto(`${ctx.baseUrl}/sessions/${sessionId}`);
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "TTY" })).toHaveAttribute("aria-pressed", "true");
  const shot = await fetchTuishot(page);
  expect(shot.contentType).toContain("image/svg+xml");
  expect(shot.disposition).toContain("inline");
  expect(shot.body).toContain("<svg");
  expect(shot.body).toContain("OpenAI Codex");
  expect(shot.body).toContain("three");

  await clickSessionMenuButton(page, "Logs");
  await expect(page.getByTestId("stdin-log")).toContainText("what is one plus two");
  await expect(page.getByTestId("stdout-log")).toContainText("three");
});

test("keeps the promptbox draft in localStorage per session", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);
  const firstSessionId = (await fetchSessionPayload(page)).id;
  const promptbox = page.locator("[data-label='promptbox']");
  const storedPromptboxDraft = async (sessionId: string) => {
    return await page.evaluate((id) => {
      return localStorage.getItem(`tuiui-promptbox-${encodeURIComponent(id)}`);
    }, sessionId);
  };

  await expect(promptbox).toHaveAttribute("aria-label", "Send stdin");
  await promptbox.fill("draft from phone");
  await expect.poll(() => storedPromptboxDraft(firstSessionId)).toBe("draft from phone");

  await page.reload();
  await expect(promptbox).toHaveValue("draft from phone");

  await launchFakeCodex(page, ctx);
  const secondSessionId = (await fetchSessionPayload(page)).id;
  expect(secondSessionId).not.toBe(firstSessionId);
  await expect(promptbox).toHaveValue("");
  await promptbox.fill("different session draft");

  await page.goto(`${ctx.baseUrl}/sessions/${firstSessionId}`);
  await expect(promptbox).toHaveValue("draft from phone");
  await promptbox.press("Enter");
  await expect(promptbox).toHaveValue("");
  await expect.poll(() => storedPromptboxDraft(firstSessionId)).toBe(null);

  await page.goto(`${ctx.baseUrl}/sessions/${secondSessionId}`);
  await expect(promptbox).toHaveValue("different session draft");
});

test("uploads composer attachments to a session temp directory and inserts the saved path", async ({ page, ctx }) => {
  const firstImagePath = path.join(ctx.tempRoot, "tiny.png");
  const imageBytes = Buffer.from(tinyPngBase64, "base64");
  fs.writeFileSync(firstImagePath, imageBytes);

  await page.goto(ctx.baseUrl);
  await page.getByRole("textbox", { name: "Command" }).fill("bytewise-ui");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");
  await expect(page.getByTestId("semantic-screen")).toContainText("──hello──");

  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach file" }).click();
  await (await fileChooser).setFiles(firstImagePath);

  const textarea = page.getByRole("textbox", { name: "Send stdin" });
  const rowsBeforeAttachment = (await fetchSessionPayload(page)).rows;
  await expect(textarea).toHaveValue(/\/tuiui-attachments-[^/]+\/tuiui_[a-f0-9]+\/tiny\.png/);
  const firstSavedPath = (await textarea.inputValue()).trim();
  expect(fs.existsSync(firstSavedPath)).toBe(true);
  expect(fs.readFileSync(firstSavedPath).equals(imageBytes)).toBe(true);
  const attachmentPreview = page.getByTestId("attachment-preview");
  await expect(attachmentPreview.locator("img")).toBeVisible();
  await expect.poll(async () => (await fetchSessionPayload(page)).rows).toBe(rowsBeforeAttachment);
  await attachmentPreview.getByRole("button", { name: "Preview tiny.png" }).click();
  await expect(page.getByTestId("attachment-dialog")).toBeVisible();
  await expect(page.getByTestId("attachment-dialog")).toContainText(firstSavedPath);
  await page.getByRole("button", { name: "Insert path" }).click();
  await expect(textarea).toHaveValue(firstSavedPath);

  await textarea.fill("");
  await expect(attachmentPreview.locator("img")).toBeVisible();
  await attachmentPreview.getByRole("button", { name: /Remove tiny\.png/ }).click();
  await expect(textarea).toHaveValue("");
  await expect(attachmentPreview).toBeHidden();

  await page.locator(".composer").evaluate((composer, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    const event = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    composer.dispatchEvent(event);
  }, tinyPngBase64);

  await expect(textarea).toHaveValue(/\/tuiui-attachments-[^/]+\/tuiui_[a-f0-9]+\/dropped\.png/);
  const paths = (await textarea.inputValue()).trim().split(/\s+/);
  expect(paths).toHaveLength(1);
  expect(fs.existsSync(paths[0]!)).toBe(true);
  await expect(attachmentPreview.locator("img")).toHaveCount(1);

  const sentText = await textarea.inputValue();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(textarea).toHaveValue("");
  await expect(attachmentPreview).toBeHidden();
  await expect.poll(async () => {
    return (await fetchSessionPayload(page)).stdinEvents.at(-1)?.text;
  }).toBe(sentText);
});

test("explains that attachment uploads need a restarted server when the route is missing", async ({ page, ctx }) => {
  const imagePath = path.join(ctx.tempRoot, "tiny.png");
  fs.writeFileSync(imagePath, Buffer.from(tinyPngBase64, "base64"));
  await page.route("**/api/sessions/*/attachments", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "not found",
    });
  });

  await page.goto(ctx.baseUrl);
  await page.getByRole("textbox", { name: "Command" }).fill("bytewise-ui");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");
  await expect(page.getByTestId("semantic-screen")).toContainText("──hello──");

  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach file" }).click();
  await (await fileChooser).setFiles(imagePath);

  await expect(page.getByTestId("attachment-upload-error-toast")).toContainText("Restart tuiui");
});

test("exposes real and fake launcher presets as one-click button rows", async ({ page, ctx }) => {
  await useLegacyApi(page);
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
    lastUserText: "make the recent cards easier to scan",
    latestAssistantText: "adding recent Codex buttons",
    messageAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  writeRecentCodexFixtureState(ctx, {
    threadId: "busy-codex-thread",
    title: "Busy Codex session",
    latestUserText: "please keep working",
    lastUserText: "are you done yet",
    latestAssistantText: "",
    messageAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  });
  writeRecentClaudeFixtureState(ctx, {
    sessionId: "00000000-0000-4000-8000-000000000456",
    title: "Claude handoff session",
    latestUserText: "resume claude from phone",
    latestAssistantText: "adding Claude recent buttons",
    messageAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  });
  await page.route("**/api/agent-sessions/recent", async (route) => {
    const response = await route.fetch();
    const sessions = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(sessions.map((session: any) => {
        if (session.provider === "codex") {
          delete session.status;
        }
        return session;
      })),
    });
  });

  await page.goto(ctx.baseUrl);

  await expect(page.getByRole("combobox", { name: "Preset" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Arguments" })).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: "Columns" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Launch" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Shortcuts" }).getByRole("button", { name: "claude", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "fakeagent" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume OpenCode session OpenCode handoff session/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume Claude session Claude handoff session/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume Codex session Busy Codex session/ })).toBeVisible();
  await expect(page.locator(".provider-pill", { hasText: "Codex" }).first()).toBeVisible();
  await expect(page.locator(".provider-pill", { hasText: "OpenCode" })).toBeVisible();
  await expect(page.locator(".provider-pill", { hasText: "Claude" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ }).locator(".agent-session-status")).toHaveText("idle");
  await expect(page.getByRole("button", { name: /Resume OpenCode session OpenCode handoff session/ }).locator(".agent-session-status")).toHaveText("idle");
  await expect(page.getByRole("button", { name: /Resume Claude session Claude handoff session/ }).locator(".agent-session-status")).toHaveText("idle");
  await expect(page.getByRole("button", { name: /Resume Codex session Busy Codex session/ }).locator(".agent-session-status")).toHaveText("busy");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText("user (first)");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText("connect to this very session from my phone");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText("user (last)");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText("make the recent cards easier to scan");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText("assistant");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText("adding recent Codex buttons");
  await expect(page.getByRole("button", { name: /Resume Codex session Phone handoff session/ })).toContainText(ctx.workspaceDir.replace(ctx.env.HOME || "", "~"));

  const rows = await page.locator(".quick-launch-row").evaluateAll((elements) => {
    return elements.map((element) => ({
      buttons: [...element.querySelectorAll("button")].map((button) => button.textContent?.trim()),
      fakeagent: element.querySelector("label")?.textContent?.trim(),
    }));
  });
  expect(rows).toMatchObject([
    { buttons: ["codex", "claude", "opencode"], fakeagent: "fakeagent" },
  ]);

  await page.getByRole("textbox", { name: "Working directory" }).fill(ctx.tempRoot);
  await expect.poll(async () => {
    return await page.evaluate(() => localStorage.getItem("tuiui-launch-cwd"));
  }).toBe(ctx.tempRoot);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Working directory" })).toHaveValue(ctx.tempRoot);

  await page.getByRole("button", { name: /Resume Codex session Phone handoff session/ }).click();
  await expect(page).toHaveURL(/\/sessions\/tuiui_[a-f0-9]+$/);
  const payload = await fetchSessionPayload(page);
  expect(payload).toMatchObject({
    command: "codex",
    args: ["resume", "mobile-codex-thread"],
    cwd: ctx.workspaceDir,
  });
});

test("loads home when a recent provider database cannot be opened", async ({ page }) => {
  using openCodeDatabasePath = createTempDirectoryAsDatabasePath("tuiui-opencode-db-path-");
  await using ctx = await createContext({ OPENCODE_DB_PATH: openCodeDatabasePath.path });

  await page.goto(ctx.baseUrl);

  await expect(page.getByRole("group", { name: "Shortcuts" }).getByRole("button", { name: "codex", exact: true })).toBeVisible();
  await expect(page.locator(".recent-agents")).toHaveCount(0);
});

test("sends named key chords separately from the composer", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);
  await clickSessionMenuButton(page, "HTML");
  await expect(page.getByTestId("semantic-screen")).toContainText("OpenAI Codex");

  const fixedChordLabels = await page.locator(".chord-fixed button").evaluateAll((buttons) => {
    return buttons.map((button) => button.getAttribute("aria-label"));
  });
  expect(fixedChordLabels).toEqual(["Chord", "Send"]);
  await expect(page.locator(".chord-fixed").getByRole("button", { name: "Send" })).toHaveCSS("background-color", "rgb(216, 243, 106)");

  await page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Esc" }).click();

  await expect.poll(async () => (await fetchSessionPayload(page)).stdinEvents.at(-1)?.text).toBe("\x1b");

  await page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Send" }).click();

  await expect.poll(async () => (await fetchSessionPayload(page)).stdinEvents.at(-1)?.text).toBe("\r");
});

test("push-to-talk sends a transcript and reads back the idle result without a real microphone", async ({ page, ctx }) => {
  await useLegacyApi(page);
  const sdkRefreshRequests: string[] = [];
  let staleSnapshotInjected = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/sdk-refresh")) {
      sdkRefreshRequests.push(request.url());
    }
  });
  await page.route("**/api/sessions/*/sdk-refresh", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (!staleSnapshotInjected && body.sdk?.summary?.latestAssistantText) {
      staleSnapshotInjected = true;
      body.sdk.summary = {
        ...body.sdk.summary,
        latestUserText: "previous question",
        latestAssistantText: "penultimate answer",
        transcript: [
          {
            id: "stale-user",
            role: "user",
            createdAt: "2026-05-11T09:59:00.000Z",
            text: "previous question",
          },
          {
            id: "stale-assistant",
            role: "assistant",
            createdAt: "2026-05-11T09:59:01.000Z",
            text: "penultimate answer",
          },
        ],
      };
    }
    await route.fulfill({
      status: response.status(),
      headers: {
        ...response.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  });

  await page.addInitScript(() => {
    const spoken: string[] = [];
    let handlers: any = null;
    (window as any).__voiceSpoken = spoken;
    (window as any).__voiceEmit = (transcript: string, final = true) => {
      handlers?.onResult({ transcript, final });
    };
    (window as any).__tuiuiVoiceTest = {
      minReadbackDelayMs: 0,
      recognizer: {
        supported: true,
        start(nextHandlers: any) {
          handlers = nextHandlers;
        },
        stop() {
        },
        cancel() {
          handlers = null;
        },
      },
      speaker: {
        supported: true,
        speak(text: string) {
          spoken.push(text);
        },
        stop() {
          spoken.push("[stop]");
        },
      },
    };
  });

  await launchFakeCodex(page, ctx);

  await page.getByRole("button", { name: "Push to talk" }).dispatchEvent("pointerdown");
  await expect(page.getByTestId("voice-status")).toContainText("Listening");
  await page.evaluate(() => {
    (window as any).__voiceEmit("what is one plus two");
  });

  await expect.poll(async () => {
    return (await fetchSessionPayload(page)).stdinEvents.at(-1)?.text;
  }).toBe("what is one plus two");
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  await expect.poll(async () => {
    return await page.evaluate(() => (window as any).__voiceSpoken);
  }).toEqual(expect.arrayContaining([expect.stringContaining("three")]));
  expect(staleSnapshotInjected).toBe(true);
  expect(sdkRefreshRequests.length).toBeGreaterThan(1);
  await expect.poll(async () => {
    return await page.evaluate(() => (window as any).__voiceSpoken);
  }).not.toEqual(expect.arrayContaining([expect.stringContaining("penultimate answer")]));
  await expect.poll(async () => {
    return await page.evaluate(() => (window as any).__voiceSpoken[0]);
  }).toContain("Sent: what is one plus two");
  await expect(page.getByTestId("voice-status")).toContainText("Readback complete");
});

test("hides voice controls when browser voice APIs are unavailable", async ({ page, ctx }) => {
  await page.addInitScript(() => {
    (window as any).__tuiuiVoiceTest = {
      recognizer: {
        supported: false,
        start() {
        },
        stop() {
        },
        cancel() {
        },
      },
      speaker: {
        supported: true,
        speak() {
        },
        stop() {
        },
      },
    };
  });

  await launchFakeCodex(page, ctx);

  await expect(page.locator(".voice-controls")).toBeHidden();
});

test("shortcut chord buttons do not return focus to the composer", async ({ page, ctx }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await launchFakeCodex(page, ctx);

  const composer = page.getByRole("textbox", { name: "Send stdin" });
  await composer.focus();
  await expect(composer).toBeFocused();
  await page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Esc" }).click();

  await expect.poll(async () => (await fetchSessionPayload(page)).stdinEvents.at(-1)?.text).toBe("\x1b");
  expect(await composer.evaluate((element) => document.activeElement === element)).toBe(false);
});

test("renders binary-aware chord presets and sends user-defined chords", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);
  await expect(page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Tab" })).toHaveText("⇥");

  await page.getByRole("button", { name: "Chord", exact: true }).click();
  await page.getByRole("textbox", { name: "Chord label" }).fill("Ask");
  await page.getByRole("textbox", { name: "Chord sequence" }).fill("what is one plus two;enter");
  await page.getByRole("button", { name: "Save + Send" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  await expect(page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Ask" })).toBeVisible();

  await page.getByRole("button", { name: "Chord", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add chord" })).toBeVisible();
  await expect(page.locator(".chord-panel-input-row").getByText("↵")).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Ask");
    await dialog.accept();
  });
  await page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Ask" }).click();

  await expect(page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Ask" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Chord", exact: true })).toHaveAttribute("aria-expanded", "true");
});

test("orders chord presets by the running agent binary", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "codex", exact: true }).click();
  await expect(page.getByRole("group", { name: "Shortcut chords" }).getByRole("button", { name: "Ctrl-J" })).toHaveText("^J");
  await expect(page.getByRole("group", { name: "Shortcut chords" }).locator("button").first()).toHaveText("esc");

  await page.goto(ctx.baseUrl);
  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "opencode", exact: true }).click();
  await expect(page.getByRole("group", { name: "Shortcut chords" }).locator("button").first()).toHaveText("esc esc");
});

test("can type directly into the terminal renderer", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);

  await page.locator(".terminal-host").click();
  await page.keyboard.type("what is one plus two");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("rendered-terminal")).toContainText("three", { timeout: 8_000 });
  const payload = await fetchSessionPayload(page);
  expect(payload.renderedAnsi).toContain("three");

  await page.reload();
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
});

test("opens http links from terminal output in a new tab", async ({ page, ctx }) => {
  const url = "https://example.test/docs?q=tuiui";

  await page.goto(ctx.baseUrl);
  await page.getByRole("textbox", { name: "Command" }).fill("link-agent");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");
  await expect(page.getByTestId("rendered-terminal")).toContainText(url);
  await page.evaluate(() => {
    (window as any).__tuiuiOpenedTerminalLinks = [];
    window.open = ((linkUrl?: string | URL, target?: string, features?: string) => {
      (window as any).__tuiuiOpenedTerminalLinks.push({
        url: String(linkUrl),
        target: target || "",
        features: features || "",
      });
      return null;
    }) as typeof window.open;
  });

  const rowsBox = await page.locator(".xterm-rows").boundingBox();
  if (!rowsBox) {
    throw new Error("terminal rows were not rendered");
  }
  const linkX = rowsBox.x + 32;
  const linkY = rowsBox.y + 8;
  await page.mouse.move(linkX, linkY);
  await page.mouse.click(linkX, linkY);

  await expect.poll(async () => {
    return await page.evaluate(() => (window as any).__tuiuiOpenedTerminalLinks);
  }).toMatchObject([{
    url,
    target: "_blank",
    features: "noopener,noreferrer",
  }]);
});

test("keeps the terminal shell fixed while xterm owns scrolling", async ({ page, ctx }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await launchFakeCodex(page, ctx);

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

test("keeps mobile session chrome compact without document scrolling", async ({ page }) => {
  await using ctx = await createContext({ TUIUI_PAGE_LOAD_TOASTS: "1" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ctx.baseUrl);

  const homeInputs = await page.evaluate(() => {
    const commandInput = document.querySelector<HTMLInputElement>("input[name='commandLine']")!;
    const cwdInput = document.querySelector<HTMLInputElement>("input[name='cwd']")!;
    return {
      commandFontSize: getComputedStyle(commandInput).fontSize,
      cwdFontSize: getComputedStyle(cwdInput).fontSize,
      commandTouchAction: getComputedStyle(commandInput).touchAction,
      cwdTouchAction: getComputedStyle(cwdInput).touchAction,
    };
  });
  expect(homeInputs).toMatchObject({
    commandFontSize: "16px",
    cwdFontSize: "16px",
    commandTouchAction: "manipulation",
    cwdTouchAction: "manipulation",
  });

  await page.getByRole("textbox", { name: "Command" }).fill("scrollback-agent");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");
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
  await expect(page.locator(".chord-fixed").getByRole("button", { name: "Send" })).toContainText("↵");

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

  const chordMetrics = await page.locator(".chord-shortcuts").evaluate((shortcuts) => {
    const visibleBoxes = [...shortcuts.querySelectorAll<HTMLElement>(".chord-button")]
      .filter((button) => getComputedStyle(button).display !== "none")
      .map((button) => button.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const tops = visibleBoxes.map((box) => box.top);
    return {
      visibleButtonCount: visibleBoxes.length,
      topSpread: Math.max(...tops) - Math.min(...tops),
    };
  });
  expect(chordMetrics).toMatchObject({
    visibleButtonCount: 8,
  });
  expect(chordMetrics.topSpread).toBeLessThan(2);

  const mainSurfaceHeight = await page.locator(".main-surface").evaluate((surface) => surface.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Chord", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add chord" })).toBeVisible();
  const mainSurfaceHeightWithChordDialog = await page.locator(".main-surface").evaluate((surface) => surface.getBoundingClientRect().height);
  expect(Math.abs(mainSurfaceHeightWithChordDialog - mainSurfaceHeight)).toBeLessThan(1);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("name"))).not.toBe("sequence");
  await page.getByRole("button", { name: "Close add chord" }).click();
  await expect(page.getByRole("dialog", { name: "Add chord" })).toBeHidden();

  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "TTY" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Debug", exact: true })).toBeVisible();
  await expect.poll(async () => sessionMenuPlainButtonStyles(page)).toMatchObject({
    reference: {
      alignItems: "center",
      borderTopStyle: "solid",
      display: "flex",
      fontWeight: "700",
      justifyContent: "center",
    },
    debug: {
      alignItems: "center",
      borderTopStyle: "solid",
      display: "flex",
      fontWeight: "700",
      justifyContent: "center",
    },
    matches: true,
  });
  await expect(page.getByRole("button", { name: "HTML" })).toHaveCount(0);
  await page.getByRole("button", { name: "Debug", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Session menu" })).toBeHidden();
  await expect(page.getByTestId("sdk-debug")).toBeVisible();
  await expect(page.getByTestId("debug-html")).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("debug-logs")).not.toHaveAttribute("open", "");
  await openDebugDetail(page, "debug-html");
  await expect(page.getByTestId("debug-html")).toContainText("scrollback line");
  await openDebugDetail(page, "debug-logs");
  await expect(page.getByTestId("stdout-log")).toContainText("scrollback line");
  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "Pause events" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Relayout" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close session menu" }).click();
  await expect(page.getByRole("dialog", { name: "Session menu" })).toBeHidden();
  await clickSessionMenuButton(page, "Relayout");
  await expect(page.getByTestId("terminal-redraw-overlay")).toBeVisible();
  await expect(page.locator(".menu-fact code")).toHaveText(fs.realpathSync(ctx.workspaceDir));
});

test("archives a session from the hamburger menu and hides it from Home", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);
  const sessionId = (await fetchSessionPayload(page)).id;

  await openSessionMenu(page);
  await page.getByRole("button", { name: "Archive" }).click();

  await expect(page).toHaveURL(ctx.baseUrl + "/");
  await expect(page.getByTestId("session-count")).toHaveText("0 sessions");
  await expect(page.locator(".sessions")).toContainText("No sessions");
  await expect.poll(async () => {
    return await page.evaluate(async () => await fetch("/api/sessions").then((response) => response.json()));
  }).toEqual([]);
  const archivedSession = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  }, sessionId);
  expect(archivedSession).toMatchObject({
    status: 404,
    body: { error: "Session not found" },
  });
});

test("can pause and resume live session events", async ({ page, ctx }) => {
  await launchFakeCodex(page, ctx);
  await clickSessionMenuButton(page, "Pause events");

  await openSessionMenu(page);
  await expect(page.getByRole("button", { name: "Resume events" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close session menu" }).click();
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

  await page.getByRole("textbox", { name: "Command" }).fill("bytewise-ui --smoke");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");

  await expect(page.getByTestId("semantic-screen")).toContainText("──hello──");
  await expect(page.getByTestId("semantic-screen")).not.toContainText("\uFFFD");
  expect((await fetchSessionPayload(page)).args).toEqual(["--smoke"]);
});

test("does not inherit NO_COLOR into launched TUIs", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("color-env-agent");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");

  await expect(page.getByTestId("rendered-terminal")).toContainText("colored");
  const payload = await fetchSessionPayload(page);
  expect(payload.stdoutEvents[0]).toMatchObject({
    chunk: expect.stringContaining("\u001b[31mcolored"),
  });
});

test("does not force color into launched TUIs", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("json-parser-ui");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");

  await expect(page.getByTestId("rendered-terminal")).toContainText("json parsed");
  await expect(page.getByTestId("rendered-terminal")).not.toContainText("json parse failed");
});

test("keeps launch command title when terminal output sets a weak title", async ({ page, ctx }) => {
  await page.goto(ctx.baseUrl);

  await page.getByRole("textbox", { name: "Command" }).fill("title-noise-ui");
  await page.getByRole("textbox", { name: "Command" }).press("Enter");

  await expect(page.getByTestId("rendered-terminal")).toContainText("ready");
  await expect(page.getByTestId("session-command")).toHaveText("title-noise-ui");
  await expect(page).toHaveTitle("title-noise-ui · TUI UI");
  await expect.poll(async () => (await fetchSessionPayload(page)).title).toBe("title-noise-ui");
});

test("does not let package-manager bin shims shadow fakeagent-backed Codex", async ({ page }) => {
  await using ctx = await createContextWithCodexShimShadow();

  await launchFakeCodex(page, ctx);

  await expect(page.getByTestId("rendered-terminal")).toContainText("OpenAI Codex");
  await expect(page.getByTestId("rendered-terminal")).not.toContainText("shadowed repo-local codex");
});

test("can drive OpenCode through fakeagent when OpenCode is installed", async ({ page, ctx }) => {
  await launchFakeOpenCodeWithQuestion(page, ctx);
  await clickSessionMenuButton(page, "Debug");
  await expect(page.getByTestId("sdk-debug")).toContainText("connected");
  await expect(page.getByTestId("session-brief")).toContainText("No session brief yet.");
  await expect(page.getByTestId("tuishot-preview")).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("session-brief")).not.toHaveAttribute("open", "");
  await expect(page.locator(".sdk-diagnostics")).not.toHaveAttribute("open", "");
  const refreshedPayload = await fetchSessionPayload(page);
  expect(refreshedPayload.sdk.summary.latestAssistantText).toContain("three");
  await page.getByRole("button", { name: "Get session brief" }).click();
  await expect.poll(async () => (await fetchSessionPayload(page)).sdk.sidecarSummary.status, { timeout: 20_000 }).toBe("completed");
  await page.locator(".session-brief > summary").click();
  await expect(page.getByTestId("session-brief")).toContainText("current");
  await expect(page.getByTestId("session-brief")).toContainText("Executive summary");
  await expect(page.getByTestId("session-brief")).toContainText("Suggested next actions");
  await page.getByRole("tab", { name: "Raw" }).click();
  await expect(page.getByRole("textbox", { name: "Session brief raw text" })).toContainText("<session_brief");
  const payload = await fetchSessionPayload(page);
  expect(payload.sdk.sidecarSummary).toMatchObject({
    method: "opencode.session.fork+prompt",
    status: "completed",
  });
  expect(payload.sdk.forks[0]).toMatchObject({
    provider: "opencode",
    purpose: "sidecarSummary",
    sourceSessionId: payload.sdk.externalSessionId,
    forkPoint: payload.sdk.summary.forkPoint,
    status: "summarized",
    result: true,
  });
  expect(payload.sdk.forks[0].forkSessionId).not.toBe(payload.sdk.externalSessionId);
  const recentSessions = await fetchRecentAgentSessions(page);
  expect(recentSessions.map((session: any) => session.id)).not.toContain(payload.sdk.forks[0].forkSessionId);
  expect(payload.sdk.summary).toMatchObject({ messageCount: 2 });
  await page.getByRole("button", { name: "Get session brief" }).click();
  await expect.poll(async () => (await fetchSessionPayload(page)).sdk.sidecarSummary.note).toContain("Reused the completed session brief for the current fork point.");
  const reusedPayload = await fetchSessionPayload(page);
  expect(reusedPayload.sdk.forks).toHaveLength(1);
  expect(reusedPayload.sdk.forks[0].forkSessionId).toBe(payload.sdk.forks[0].forkSessionId);
});

test("keeps provider diagnostics YAML readable and stable", async ({ page, ctx }) => {
  await launchFakeOpenCodeWithQuestion(page, ctx);
  await clickSessionMenuButton(page, "Debug");
  await page.getByRole("button", { name: "Refresh snapshot" }).click();
  await openSdkDiagnostics(page);
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("latestUserText: what is one plus two");
  await expect(page.locator("#sdk-yaml-editor .cm-line span[class]").first()).toBeVisible();
  expect(await measureFirstLineGutterOffset(page)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Get session brief" }).click();
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("method: opencode.session.fork+prompt", { timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("status: completed");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("forks:");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("forkSessionId:");
  const yamlBeforeRefresh = await page.locator("#sdk-yaml-editor .cm-content").textContent();
  const scrollBeforeRefresh = await scrollYamlEditorToBottom(page);
  expect(scrollBeforeRefresh).toBeGreaterThan(0);
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
  await expect(page.getByRole("button", { name: "opencode", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "codex", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "codex", exact: true }).click();

  await expectReadyFakeCodex(page);
  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  const launchedPayload = await fetchSessionPayload(page);
  expect(launchedPayload.title).toBe('codex "what is one plus two"');
  writeCodexFixtureState(ctx, launchedPayload.createdAt, {
    codexHomeDir: path.join(ctx.env.HOME || "", ".codex"),
    threadId: "this-tuiui-development-session",
    title: "Supervising Codex session",
    latestUserText: "fix the tuiui summary tab",
    latestAssistantText: "this is the wrong supervising session",
    createdOffsetMs: -60_000,
    updatedOffsetMs: 2_000,
  });

  await clickSessionMenuButton(page, "Debug");

  await expect(page.getByTestId("sdk-debug")).toContainText("connected");
  await openSdkDiagnostics(page);
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("provider: codex");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("baseUrl: /tmp/fakeagent-codex-home");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("state_5.sqlite");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("providerSessionId:");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("latestUserText: what is one plus two");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).toContainText("latestAssistantText: three");
  await expect(page.getByRole("textbox", { name: "Provider snapshot diagnostics YAML" })).not.toContainText("this is the wrong supervising session");
  await expect(page.getByTestId("session-command")).toContainText("what is one plus two");
  await expect(page).toHaveTitle(/what is one plus two/);
  await expect.poll(async () => {
    return await page.locator("#sdk-yaml-editor .cm-editor").evaluate((editor) => getComputedStyle(editor).fontSize);
  }).toBe("10px");

  const payload = await fetchSessionPayload(page);
  expect(payload.sdk.externalSessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(payload.sdk.summary).toMatchObject({
    provider: "codex",
    latestUserText: "what is one plus two",
    latestAssistantText: "three",
  });
});

test("shows a toast instead of an unhandled rejection when session brief fetch fails", async ({ page, ctx }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(ctx.baseUrl);
  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "codex", exact: true }).click();
  await expectReadyFakeCodex(page);
  await clickSessionMenuButton(page, "Debug");
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
  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "claude", exact: true }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("Claude test TUI");
  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("three");
  const payload = await fetchSessionPayload(page);
  expect(payload).toMatchObject({
    command: "claude",
    sdk: {
      provider: "claude",
    },
  });
  expect(["ready", "not-found"]).toContain(payload.sdk.state);
});

async function fetchSessionPayload(page: Page) {
  return await page.evaluate(async () => {
    const id = location.pathname.split("/").at(-1);
    return await fetch(`/api/sessions/${id}`).then((response) => response.json());
  });
}

function fakeSessionPayload(input: { id: string; status: "busy" | "idle" }) {
  const now = new Date().toISOString();
  return {
    id: input.id,
    title: "Busy Codex session",
    command: "codex",
    args: [],
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
    lastOutputAt: now,
    lifecycle: "running",
    status: input.status,
    exitCode: null,
    cols: 80,
    rows: 24,
    renderedText: "working",
    renderedHtml: "<div><span>working</span></div>",
    renderedAnsi: "working",
    screenVersion: 1,
    snapshotEventId: 1,
    redrawActive: false,
    blocks: {
      coordinateSystem: { origin: "top-left", x1: "exclusive", y1: "exclusive" },
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: false },
      rawText: "working",
      blocks: [],
    },
    semantic: {
      title: "Busy Codex session",
      status: input.status,
      prompt: "finish the task",
      rawText: "working",
      sections: [],
    },
    sdk: {
      provider: "codex",
      state: "ready",
      baseUrl: "",
      externalSessionId: "",
      status: "",
      updatedAt: now,
      error: "",
      sidecarSummary: {
        implemented: false,
        status: "idle",
        method: "",
        sourceSessionId: "",
        forkSessionId: "",
        forkPoint: "",
        updatedAt: "",
        result: null,
        error: "",
        note: "",
      },
      forks: [],
      summary: null,
    },
    stdinEvents: [],
    stdoutEvents: [],
  };
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

async function fetchRecentAgentSessions(page: Page) {
  return await page.evaluate(async () => {
    return await fetch("/api/agent-sessions/recent").then((response) => response.json());
  });
}

async function useLegacyApi(page: Page) {
  await page.addInitScript(() => {
    (globalThis as any).__tuiuiForceLegacyApi = true;
  });
}

function createTempDirectoryAsDatabasePath(prefix: string) {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: directoryPath,
    [Symbol.dispose]() {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    },
  };
}

async function clickSessionMenuButton(page: Page, name: string) {
  await openSessionMenu(page);
  if (name === "Debug") {
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    return;
  }
  if (name === "HTML" || name === "Logs") {
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    await openDebugDetail(page, name === "HTML" ? "debug-html" : "debug-logs");
    return;
  }
  await page.getByRole("button", { name }).click();
}

async function openSessionMenu(page: Page) {
  const menu = page.locator(".session-menu");
  if ((await menu.getAttribute("open")) !== null) {
    return;
  }
  await page.getByRole("button", { name: "Session menu" }).click();
}

async function sessionMenuPlainButtonStyles(page: Page) {
  return await page.locator(".menu-panel").evaluate((panel) => {
    const reference = panel.querySelector<HTMLElement>("[data-action='relayout']");
    const debug = panel.querySelector<HTMLElement>("[data-renderer='sdk']");
    if (!reference || !debug) {
      return { matches: false };
    }
    const pick = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        alignItems: style.alignItems,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderTopColor: style.borderTopColor,
        borderTopStyle: style.borderTopStyle,
        borderTopWidth: style.borderTopWidth,
        color: style.color,
        display: style.display,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        height: Math.round(element.getBoundingClientRect().height),
        justifyContent: style.justifyContent,
        lineHeight: style.lineHeight,
        paddingBottom: style.paddingBottom,
        paddingTop: style.paddingTop,
      };
    };
    const referenceStyle = pick(reference);
    const debugStyle = pick(debug);
    return {
      reference: referenceStyle,
      debug: debugStyle,
      matches: JSON.stringify(referenceStyle) === JSON.stringify(debugStyle),
    };
  });
}

async function openDebugDetail(page: Page, testId: "debug-html" | "debug-logs") {
  const detail = page.getByTestId(testId);
  if ((await detail.getAttribute("open")) !== null) {
    return;
  }
  await detail.locator("summary").first().click();
}

async function openSdkDiagnostics(page: Page) {
  const diagnostics = page.locator(".sdk-diagnostics");
  if ((await diagnostics.getAttribute("open")) !== null) {
    return;
  }
  await page.locator(".sdk-diagnostics > summary").click();
}

async function launchFakeCodex(page: Page, ctx: FixtureContext) {
  test.skip(!commandExists("codex"), "codex is not installed");

  await page.goto(ctx.baseUrl);
  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "codex", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/tuiui_[a-f0-9]+$/);
  await expectReadyFakeCodex(page);
}

async function launchFakeOpenCodeWithQuestion(page: Page, ctx: FixtureContext) {
  test.skip(!commandExists("opencode"), "opencode is not installed");

  await page.goto(ctx.baseUrl);
  await page.getByRole("checkbox", { name: "fakeagent" }).check();
  await page.getByRole("button", { name: "opencode", exact: true }).click();
  await expect(page.getByTestId("rendered-terminal")).toContainText(/Ask anything|OpenCode/i);

  await page.getByRole("textbox", { name: "Send stdin" }).fill("what is one plus two");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("rendered-terminal")).toContainText("three", { timeout: 20_000 });
}

async function expectReadyFakeCodex(page: Page) {
  const terminal = page.getByTestId("rendered-terminal");
  await expect(terminal).toContainText("OpenAI Codex", { timeout: 8_000 });
  await expect(terminal).not.toContainText(/upgrade|sign in|login|api key|trust this folder|continue\?/i);
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

async function createContext(envOverrides: Record<string, string> = {}) {
  return await createContextWithPathPrefix("", envOverrides);
}

async function createContextWithCodexShimShadow() {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-codex-shadow-"));
  const shadowBinDir = path.join(shadowRoot, "node_modules", ".bin");
  fs.mkdirSync(shadowBinDir, { recursive: true });
  fs.writeFileSync(path.join(shadowBinDir, "codex"), `#!/usr/bin/env node
process.stdout.write("shadowed repo-local codex\\n");
setTimeout(() => process.exit(0), 100);
`, { mode: 0o755 });
  const ctx = await createContextWithPathPrefix(shadowBinDir, {});
  return {
    ...ctx,
    async [Symbol.asyncDispose]() {
      await ctx[Symbol.asyncDispose]();
      fs.rmSync(shadowRoot, { recursive: true, force: true });
    },
  };
}

async function createContextWithPathPrefix(pathPrefix: string, envOverrides: Record<string, string>) {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-spec-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const fakeBinDir = path.join(tempRoot, "bin");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(path.join(fakeBinDir, "bytewise-ui"), bytewiseUiSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "color-env-agent"), colorEnvAgentSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "json-cli"), jsonCliSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "json-parser-ui"), jsonParserUiSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "title-noise-ui"), titleNoiseUiSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "scrollback-agent"), scrollbackAgentSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "link-agent"), linkAgentSource, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, "claude"), claudeTuiSource, { mode: 0o755 });

  const port = await getFreePort();
  const pathParts = [pathPrefix, fakeBinDir, process.env.PATH || ""].filter(Boolean);
  const env = {
    ...process.env,
    PATH: pathParts.join(path.delimiter),
    HOME: path.join(tempRoot, "home"),
    NO_COLOR: "1",
    ...envOverrides,
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

const jsonCliSource = `#!/usr/bin/env node
const json = JSON.stringify({ ok: true });
if (process.env.FORCE_COLOR || process.env.CLICOLOR_FORCE) {
  process.stdout.write("\\x1b[32m" + json + "\\x1b[0m\\n");
} else {
  process.stdout.write(json + "\\n");
}
`;

const jsonParserUiSource = `#!/usr/bin/env node
const childProcess = require("node:child_process");
const result = childProcess.spawnSync("json-cli", { encoding: "utf8" });
try {
  JSON.parse(result.stdout);
  process.stdout.write("json parsed\\n");
} catch {
  process.stdout.write("json parse failed\\n");
  process.stdout.write(result.stdout);
}
setTimeout(() => {}, 100000);
`;

const titleNoiseUiSource = `#!/usr/bin/env node
process.stdout.write("\\x1b]0;not the title\\x07ready\\n");
setTimeout(() => {}, 100000);
`;

const scrollbackAgentSource = `#!/usr/bin/env node
for (let index = 1; index <= 80; index += 1) {
  process.stdout.write("scrollback line " + String(index).padStart(2, "0") + "\\r\\n");
}
setTimeout(() => {}, 100000);
`;

const linkAgentSource = `#!/usr/bin/env node
process.stdout.write("https://example.test/docs?q=tuiui\\r\\n");
setTimeout(() => {}, 100000);
`;

const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

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
    lastUserText: string;
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
    codexRolloutMessage(new Date(messageAtMs - 2_000).toISOString(), "user", options.latestUserText),
    codexRolloutMessage(new Date(messageAtMs - 1_000).toISOString(), "user", options.lastUserText),
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
