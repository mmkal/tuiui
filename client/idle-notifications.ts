export type IdleNotificationStatus = "busy" | "idle" | "exited";

export type IdleNotificationSession = {
  key: string;
  providerLabel: string;
  title: string;
  cwd: string;
  task: string;
  status: IdleNotificationStatus;
  routePath: string;
};

export type IdleNotificationPermissionState = NotificationPermission | "unsupported";

export type IdleNotificationControlState = {
  enabled: boolean;
  permission: IdleNotificationPermissionState;
  label: string;
  description: string;
};

type IdleNotificationStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type IdleNotificationToast = {
  id: string;
  title: string;
  message: string;
  tone: "info";
  durationMs: number;
  testId: string;
};

export type IdleNotificationHandle = {
  onclick: ((event: Event) => void) | null;
  close?: () => void;
};

export type IdleNotificationNativeApi = {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  create(title: string, options: NotificationOptions): IdleNotificationHandle;
};

type BrowserIdleNotificationsInput = {
  storage: IdleNotificationStorage;
  notifications: IdleNotificationNativeApi | null;
  showToast(input: IdleNotificationToast): void;
  openRoute(path: string): void;
};

const storageKey = "tuiui-browser-idle-notifications-enabled";

export class BrowserIdleNotifications {
  private enabled: boolean;
  private statuses = new Map<string, IdleNotificationStatus>();
  private transitionCounts = new Map<string, number>();

  constructor(private input: BrowserIdleNotificationsInput) {
    this.enabled = this.readEnabled();
  }

  isEnabled() {
    return this.enabled;
  }

  getControlState(): IdleNotificationControlState {
    const permission = this.permission();
    if (!this.enabled) {
      return {
        enabled: false,
        permission,
        label: "Idle alerts: off",
        description: permission === "unsupported"
          ? "Browser notifications are unavailable. Enable idle alerts to use in-app toasts while this tab is open."
          : "Enable browser notifications for sessions that become idle.",
      };
    }

    if (permission === "granted") {
      return {
        enabled: true,
        permission,
        label: "Idle alerts: browser",
        description: "Browser notifications are enabled for busy sessions that become idle.",
      };
    }

    if (permission === "denied") {
      return {
        enabled: true,
        permission,
        label: "Idle alerts: in-app only",
        description: "Browser notifications are blocked. Idle alerts will appear inside TUI UI while this tab is open.",
      };
    }

    if (permission === "unsupported") {
      return {
        enabled: true,
        permission,
        label: "Idle alerts: in-app only",
        description: "Browser notifications are unavailable. Idle alerts will appear inside TUI UI while this tab is open.",
      };
    }

    return {
      enabled: true,
      permission,
      label: "Idle alerts: permission needed",
      description: "Click to allow browser notifications. TUI UI will use in-app toasts until permission is granted.",
    };
  }

  async enableFromUserGesture() {
    this.enabled = true;
    this.writeEnabled(true);

    const notifications = this.input.notifications;
    if (notifications && notifications.permission === "default") {
      try {
        await notifications.requestPermission();
      } catch {
      }
    }

    return this.getControlState();
  }

  disable() {
    this.enabled = false;
    this.writeEnabled(false);
    return this.getControlState();
  }

  observe(sessions: IdleNotificationSession[]) {
    for (const session of sessions) {
      this.observeOne(session);
    }
  }

  prime(sessions: IdleNotificationSession[]) {
    for (const session of sessions) {
      this.primeOne(session);
    }
  }

  primeOne(session: IdleNotificationSession) {
    this.statuses.set(session.key, session.status);
  }

  observeOne(session: IdleNotificationSession) {
    const previousStatus = this.statuses.get(session.key);
    this.statuses.set(session.key, session.status);
    if (!this.enabled || previousStatus !== "busy" || session.status !== "idle") {
      return;
    }
    this.notify(session);
  }

  private notify(session: IdleNotificationSession) {
    const title = `${session.providerLabel} idle: ${session.title || session.key}`;
    const body = formatIdleNotificationBody(session);
    const notifications = this.input.notifications;
    if (notifications && notifications.permission === "granted") {
      const nextCount = (this.transitionCounts.get(session.key) || 0) + 1;
      this.transitionCounts.set(session.key, nextCount);
      try {
        const notification = notifications.create(title, {
          body,
          tag: `tuiui-idle:${session.key}:${nextCount}`,
        });
        notification.onclick = () => {
          notification.close?.();
          if (session.routePath) {
            this.input.openRoute(session.routePath);
          }
        };
        return;
      } catch {
      }
    }

    this.input.showToast({
      id: `agent-idle-notification-${session.key}`,
      title,
      message: body.replace(/\n/g, " · "),
      tone: "info",
      durationMs: 10_000,
      testId: "agent-idle-notification-toast",
    });
  }

  private permission(): IdleNotificationPermissionState {
    return this.input.notifications ? this.input.notifications.permission : "unsupported";
  }

  private readEnabled() {
    try {
      return this.input.storage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  }

  private writeEnabled(enabled: boolean) {
    try {
      if (enabled) {
        this.input.storage.setItem(storageKey, "1");
      } else {
        this.input.storage.removeItem(storageKey);
      }
    } catch {
    }
  }
}

export function formatIdleNotificationBody(session: IdleNotificationSession) {
  return [
    session.cwd ? `cwd: ${session.cwd}` : "",
    session.task,
  ].filter(Boolean).join("\n");
}
