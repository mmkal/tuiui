import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatCommandLine, parseCommandLine } from "../src/command-line.ts";
import { createSessionStore } from "../src/session-store.ts";

test("records sessions and later attaches a recovery command", () => {
  using store = createSessionStore(":memory:");

  store.recordSession({
    id: "tuiui_store_test",
    cwd: "/tmp/tuiui-store",
    launchCommand: "codex --model gpt-5.4",
    createdAtMs: 1_000,
  });

  expect(store.getSession("tuiui_store_test")).toMatchObject({
    id: "tuiui_store_test",
    cwd: "/tmp/tuiui-store",
    launchCommand: "codex --model gpt-5.4",
    createdAtMs: 1_000,
    recoveryCommand: null,
    recoveryCreatedAtMs: null,
  });

  store.setSessionRecovery({
    sessionId: "tuiui_store_test",
    recoveryCommand: "codex resume thread-123",
    createdAtMs: 2_000,
  });

  expect(store.getSession("tuiui_store_test")).toMatchObject({
    recoveryCommand: "codex resume thread-123",
    recoveryCreatedAtMs: 2_000,
  });
});

test("archives stored sessions without deleting their recovery metadata", () => {
  using store = createSessionStore(":memory:");

  store.recordSession({
    id: "tuiui_archived_session",
    cwd: "/tmp/tuiui-store",
    launchCommand: "codex",
    createdAtMs: 1_000,
  });
  store.setSessionRecovery({
    sessionId: "tuiui_archived_session",
    recoveryCommand: "codex resume archived-thread",
    createdAtMs: 2_000,
  });

  store.archiveSession({
    sessionId: "tuiui_archived_session",
    archivedAtMs: 3_000,
  });

  expect(store.getSession("tuiui_archived_session")).toMatchObject({
    archivedAtMs: 3_000,
    recoveryCommand: "codex resume archived-thread",
    recoveryCreatedAtMs: 2_000,
  });
});

test("formats recovery commands so they can be parsed again", () => {
  const commandLine = formatCommandLine("codex", ["resume", "thread with spaces"]);

  expect(commandLine).toBe("codex resume 'thread with spaces'");
  expect(parseCommandLine(commandLine)).toMatchObject({
    command: "codex",
    args: ["resume", "thread with spaces"],
  });
});

test("records and removes active session process owners", () => {
  using fixture = createFileBackedStore();

  fixture.store.recordSession({
    id: "owner_session",
    cwd: "/tmp/tuiui-store",
    launchCommand: "codex",
    createdAtMs: 1_000,
  });
  fixture.store.setSessionRecovery({
    sessionId: "owner_session",
    recoveryCommand: "codex resume owner_session",
    createdAtMs: 2_000,
  });
  fixture.store.recordSessionProcessOwner({
    sessionId: "owner_session",
    pid: 123,
    createdAtMs: 3_000,
    updatedAtMs: 3_000,
  });

  expect(fixture.ownerRows()).toEqual([
    {
      created_at_ms: 3_000,
      pid: 123,
      session_id: "owner_session",
      updated_at_ms: 3_000,
    },
  ]);

  fixture.store.removeSessionProcessOwner({
    sessionId: "owner_session",
    pid: 123,
  });

  expect(fixture.ownerRows()).toEqual([]);
});

function createFileBackedStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-session-store-"));
  const databasePath = path.join(root, "state.sqlite");
  const store = createSessionStore(databasePath);

  return {
    store,
    ownerRows() {
      const database = new Database(databasePath);
      try {
        return database.query("select * from session_process_owners order by session_id, pid").all();
      } finally {
        database.close();
      }
    },
    [Symbol.dispose]() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
