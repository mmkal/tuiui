import { expect, test } from "bun:test";
import {
  BrowserIdleNotifications,
  type IdleNotificationHandle,
  type IdleNotificationNativeApi,
  type IdleNotificationSession,
} from "../client/idle-notifications.ts";

test("does not notify for an initially idle session", () => {
  const harness = createHarness({ permission: "denied", enabled: true });

  harness.notifier.observeOne(session({ status: "idle" }));
  harness.notifier.observeOne(session({ status: "idle" }));

  expect(harness.toasts).toEqual([]);
  expect(harness.notifications.created).toEqual([]);
});

test("notifies once when a busy session becomes idle", () => {
  const harness = createHarness({ permission: "denied", enabled: true });

  harness.notifier.observeOne(session({ status: "busy" }));
  harness.notifier.observeOne(session({ status: "idle" }));
  harness.notifier.observeOne(session({ status: "idle" }));

  expect(harness.toasts).toHaveLength(1);
  expect(harness.toasts[0]).toMatchObject({
    id: "agent-idle-notification-tuiui:session-1",
    title: "Codex idle: Fix browser notifications",
    message: "cwd: ~/src/tuiui · finish the idle notification task",
    testId: "agent-idle-notification-toast",
  });
});

test("falls back to an in-app toast when browser notifications are unavailable", () => {
  const harness = createHarness({ permission: "unsupported", enabled: true });

  harness.notifier.observe([
    session({ status: "busy", key: "codex:thread-1", routePath: "" }),
    session({ status: "idle", key: "codex:thread-1", routePath: "" }),
  ]);

  expect(harness.toasts).toHaveLength(1);
  expect(harness.notifications.created).toEqual([]);
});

test("uses native notifications and routes clicks when permission is granted", () => {
  const harness = createHarness({ permission: "granted", enabled: true });

  harness.notifier.observeOne(session({ status: "busy" }));
  harness.notifier.observeOne(session({ status: "idle" }));

  expect(harness.toasts).toEqual([]);
  expect(harness.notifications.created).toHaveLength(1);
  expect(harness.notifications.created[0]).toMatchObject({
    title: "Codex idle: Fix browser notifications",
    options: {
      body: "cwd: ~/src/tuiui\nfinish the idle notification task",
      tag: "tuiui-idle:tuiui:session-1:1",
    },
  });

  harness.notifications.created[0]!.handle.onclick?.(new Event("click"));

  expect(harness.openedRoutes).toEqual(["/sessions/session-1"]);
  expect(harness.notifications.created[0]!.handle.closed).toBe(true);
});

test("falls back to an in-app toast when native notification construction throws", () => {
  const harness = createHarness({ permission: "granted", enabled: true, throwOnCreate: true });

  harness.notifier.observeOne(session({ status: "busy" }));
  harness.notifier.observeOne(session({ status: "idle" }));

  expect(harness.notifications.created).toEqual([]);
  expect(harness.toasts).toHaveLength(1);
  expect(harness.toasts[0]).toMatchObject({
    title: "Codex idle: Fix browser notifications",
    testId: "agent-idle-notification-toast",
  });
});

test("requests browser notification permission only from the enable flow", async () => {
  const harness = createHarness({ permission: "default", enabled: false });

  expect(harness.notifications.requestCount).toBe(0);
  expect(harness.notifier.getControlState()).toMatchObject({
    enabled: false,
    label: "Idle alerts: off",
  });

  await harness.notifier.enableFromUserGesture();

  expect(harness.notifications.requestCount).toBe(1);
  expect(harness.notifier.getControlState()).toMatchObject({
    enabled: true,
    permission: "granted",
    label: "Idle alerts: browser",
  });
  expect(harness.storage.getItem("tuiui-browser-idle-notifications-enabled")).toBe("1");
});

test("can prime an enable-time snapshot without notifying", async () => {
  const harness = createHarness({ permission: "denied", enabled: false });

  await harness.notifier.enableFromUserGesture();
  harness.notifier.prime([
    session({ status: "idle", key: "already-idle" }),
    session({ status: "busy", key: "working" }),
  ]);
  harness.notifier.observe([
    session({ status: "idle", key: "already-idle" }),
    session({ status: "idle", key: "working" }),
  ]);

  expect(harness.toasts.map((toast) => toast.id)).toEqual(["agent-idle-notification-working"]);
});

function session(input: { status: "busy" | "idle"; key?: string; routePath?: string }): IdleNotificationSession {
  return {
    key: input.key || "tuiui:session-1",
    providerLabel: "Codex",
    title: "Fix browser notifications",
    cwd: "~/src/tuiui",
    task: "finish the idle notification task",
    status: input.status,
    routePath: input.routePath === undefined ? "/sessions/session-1" : input.routePath,
  };
}

function createHarness(input: {
  permission: NotificationPermission | "unsupported";
  enabled: boolean;
  throwOnCreate?: boolean;
}) {
  const storage = createMemoryStorage();
  if (input.enabled) {
    storage.setItem("tuiui-browser-idle-notifications-enabled", "1");
  }
  const toasts: any[] = [];
  const openedRoutes: string[] = [];
  const notifications = createNotificationApi(input.permission, Boolean(input.throwOnCreate));
  const notifier = new BrowserIdleNotifications({
    storage,
    notifications: notifications.api,
    showToast(toast) {
      toasts.push(toast);
    },
    openRoute(path) {
      openedRoutes.push(path);
    },
  });

  return {
    notifier,
    storage,
    toasts,
    openedRoutes,
    notifications,
  };
}

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) || null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function createNotificationApi(permission: NotificationPermission | "unsupported", throwOnCreate: boolean) {
  const created: Array<{ title: string; options: NotificationOptions; handle: TestNotificationHandle }> = [];
  let currentPermission = permission;
  let requestCount = 0;
  const api: IdleNotificationNativeApi | null = permission === "unsupported" ? null : {
    get permission() {
      return currentPermission as NotificationPermission;
    },
    async requestPermission() {
      requestCount += 1;
      currentPermission = "granted";
      return currentPermission;
    },
    create(title: string, options: NotificationOptions) {
      if (throwOnCreate) {
        throw new Error("native notification failed");
      }
      const handle: TestNotificationHandle = {
        onclick: null,
        closed: false,
        close() {
          handle.closed = true;
        },
      };
      created.push({ title, options, handle });
      return handle;
    },
  };
  return {
    api,
    created,
    get requestCount() {
      return requestCount;
    },
  };
}

type TestNotificationHandle = IdleNotificationHandle & {
  closed: boolean;
};
