#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { formatCommandLine } from "./command-line.ts";
import { sessionStorePathForEnv } from "./state-db-path.ts";

type SessionProcessOwner = {
  sessionId: string;
  pid: number;
  startedAtMs: number;
  updatedAtMs: number;
};

type SessionDiscovery = {
  id: string;
  mtimeMs: number;
};

export async function runCodexLease(args: string[]) {
  const realCodex = findRealCodex();
  if (!realCodex) {
    console.error("codex-lease: could not find the real codex binary. Set REALCODEX or CODEX_LEASE_CODEX_BIN.");
    return 127;
  }

  cleanupStaleOwners();

  const resumeId = findResumeId(args);
  if (resumeId) {
    await terminateOwnersForRecoveryCommand(formatCommandLine("codex", args));
  }

  return runRealCodex(realCodex, args, resumeId);
}

function findRealCodex() {
  const configured = process.env.REALCODEX || process.env.CODEX_LEASE_CODEX_BIN;
  if (configured) {
    return configured;
  }

  const found = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8" });
  if (found.status !== 0) {
    return "";
  }

  return found.stdout.trim();
}

async function runRealCodex(realCodex: string, args: string[], knownSessionId: string) {
  const startedAtMs = Date.now();
  const launchCommand = formatCommandLine("codex", args);
  const child = spawn(realCodex, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const childPid = child.pid || 0;

  if (knownSessionId) {
    recordRecoverableSessionOwner({
      command: launchCommand,
      pid: childPid,
      sessionId: knownSessionId,
      startedAtMs,
      updatedAtMs: Date.now(),
    });
  }

  let discovery = Promise.resolve("");
  if (knownSessionId) {
    discovery = Promise.resolve(knownSessionId);
  } else if (childPid) {
    discovery = discoverSessionIdForChild({
      childPid,
      cwd: process.cwd(),
      startedAtMs,
    }).then((sessionId) => {
      if (sessionId) {
        recordRecoverableSessionOwner({
          command: launchCommand,
          pid: childPid,
          sessionId,
          startedAtMs,
          updatedAtMs: Date.now(),
        });
      }
      return sessionId;
    });
  }

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      console.error(error);
      resolve({ code: 127, signal: null });
    });
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  const sessionId = await discovery;
  if (sessionId) {
    removeSessionProcessOwner(sessionId, childPid);
  }

  if (result.signal) {
    return 128 + signalNumber(result.signal);
  }
  return result.code || 0;
}

function findResumeId(args: string[]) {
  const index = args.indexOf("resume");
  if (index === -1) {
    return "";
  }

  const candidate = args[index + 1] || "";
  if (!candidate || candidate.startsWith("-")) {
    return "";
  }

  return candidate;
}

async function terminateOwnersForRecoveryCommand(recoveryCommand: string) {
  const owners = getActiveOwnersForRecoveryCommand(recoveryCommand);

  for (const owner of owners) {
    await terminateOwner(owner);
  }
}

async function terminateOwner(owner: SessionProcessOwner) {
  const timeoutMs = Number(process.env.TUIUI_CODEX_LEASE_KILL_TIMEOUT_MS || 2_000);
  try {
    process.kill(owner.pid, "SIGTERM");
  } catch {
    removeSessionProcessOwner(owner.sessionId, owner.pid);
    return;
  }

  const stopped = await waitForPidExit(owner.pid, timeoutMs);
  if (!stopped) {
    try {
      process.kill(owner.pid, "SIGKILL");
    } catch {
    }
    await waitForPidExit(owner.pid, 1_000);
  }

  removeSessionProcessOwner(owner.sessionId, owner.pid);
}

function getActiveOwnersForRecoveryCommand(recoveryCommand: string) {
  cleanupStaleOwners();
  return withDatabase((database) => database.prepare(`
    select
      session_process_owners.session_id as sessionId,
      session_process_owners.pid,
      session_process_owners.created_at_ms as startedAtMs,
      session_process_owners.updated_at_ms as updatedAtMs
    from session_process_owners
    inner join session_recovery on session_recovery.session_id = session_process_owners.session_id
    where session_recovery.recovery_command = ?
  `).all(recoveryCommand) as SessionProcessOwner[]);
}

function cleanupStaleOwners() {
  withDatabase((database) => {
    const owners = database.prepare(`
      select
        session_id as sessionId,
        pid,
        created_at_ms as startedAtMs,
        updated_at_ms as updatedAtMs
      from session_process_owners
    `).all() as SessionProcessOwner[];
    for (const owner of owners) {
      if (!isProcessAlive(owner.pid)) {
        deleteSessionProcessOwner(database, owner.sessionId, owner.pid);
      }
    }
  });
}

function recordRecoverableSessionOwner(input: {
  command: string;
  pid: number;
  sessionId: string;
  startedAtMs: number;
  updatedAtMs: number;
}) {
  if (!input.pid) {
    return;
  }

  const recoveryCommand = formatCommandLine("codex", ["resume", input.sessionId]);
  withDatabase((database) => {
    database.prepare(`
      insert into sessions (
        id,
        cwd,
        launch_command,
        created_at_ms
      )
      values (?, ?, ?, ?)
      on conflict (id) do nothing
    `).run(input.sessionId, process.cwd(), input.command, input.startedAtMs);
    database.prepare(`
      insert into session_recovery (
        session_id,
        recovery_command,
        created_at_ms
      )
      values (?, ?, ?)
      on conflict (session_id) do update set
        recovery_command = excluded.recovery_command
    `).run(input.sessionId, recoveryCommand, input.startedAtMs);
    database.prepare(`
      insert into session_process_owners (
        session_id,
        pid,
        created_at_ms,
        updated_at_ms
      )
      values (?, ?, ?, ?)
      on conflict (session_id, pid) do update set
        updated_at_ms = excluded.updated_at_ms
    `).run(input.sessionId, input.pid, input.startedAtMs, input.updatedAtMs);
  });
}

function removeSessionProcessOwner(sessionId: string, pid: number) {
  withDatabase((database) => {
    deleteSessionProcessOwner(database, sessionId, pid);
  });
}

function deleteSessionProcessOwner(database: DatabaseSync, sessionId: string, pid: number) {
  database.prepare(`
    delete from session_process_owners
    where session_id = ?
      and pid = ?
  `).run(sessionId, pid);
}

async function discoverSessionIdForChild(params: { childPid: number; cwd: string; startedAtMs: number }) {
  const attempts = Number(process.env.TUIUI_CODEX_LEASE_DISCOVERY_ATTEMPTS || 100);
  const intervalMs = Number(process.env.TUIUI_CODEX_LEASE_DISCOVERY_INTERVAL_MS || 100);

  for (let i = 0; i < attempts; i += 1) {
    const session = findNewestSessionForCwd(params.cwd, params.startedAtMs);
    if (session) {
      return session.id;
    }

    if (params.childPid && !isProcessAlive(params.childPid)) {
      return findNewestSessionForCwd(params.cwd, params.startedAtMs)?.id || "";
    }

    await delay(intervalMs);
  }

  return "";
}

function findNewestSessionForCwd(cwd: string, startedAtMs: number) {
  const sessionsDir = path.join(codexHome(), "sessions");
  const candidates: SessionDiscovery[] = [];
  collectSessionFiles(sessionsDir, candidates, cwd, startedAtMs);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0] || null;
}

function collectSessionFiles(dir: string, candidates: SessionDiscovery[], cwd: string, startedAtMs: number) {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSessionFiles(entryPath, candidates, cwd, startedAtMs);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const stat = fs.statSync(entryPath);
    if (stat.mtimeMs < startedAtMs - 5_000) {
      continue;
    }

    const session = readSessionMeta(entryPath);
    if (session && session.cwd === cwd) {
      candidates.push({ id: session.id, mtimeMs: stat.mtimeMs });
    }
  }
}

function readSessionMeta(filePath: string) {
  const firstLine = fs.readFileSync(filePath, "utf8").split("\n")[0] || "";
  if (!firstLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(firstLine) as any;
    const payload = parsed.payload;
    if (parsed.type === "session_meta" && typeof payload?.id === "string" && typeof payload?.cwd === "string") {
      return { id: payload.id, cwd: payload.cwd };
    }
  } catch {
  }

  const id = entryPathSessionId(filePath);
  return id ? { id, cwd: "" } : null;
}

function entryPathSessionId(filePath: string) {
  const match = path.basename(filePath).match(/([0-9a-fA-F-]{36})\.jsonl$/);
  return match ? match[1] : "";
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function withDatabase<T>(useDatabase: (database: DatabaseSync) => T) {
  const databasePath = sessionStorePathForEnv(process.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("pragma foreign_keys = on;");
    database.exec(fs.readFileSync(path.resolve(import.meta.dirname, "../db/definitions.sql"), "utf8"));
    return useDatabase(database);
  } finally {
    database.close();
  }
}

function isProcessAlive(pid: number) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(25);
  }
  return !isProcessAlive(pid);
}

function signalNumber(signal: NodeJS.Signals) {
  const signals: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return signals[signal] || 1;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
