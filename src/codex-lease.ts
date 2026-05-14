#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

type Lease = {
  sessionId: string;
  pid: number;
  cwd: string;
  tty: string;
  command: string[];
  startedAtMs: number;
  updatedAtMs: number;
  source: "tuiui-codex-lease";
};

type LeaseRegistry = {
  leases: Lease[];
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

  cleanupStaleLeases();

  const resumeId = findResumeId(args);
  if (resumeId) {
    await terminateActiveLease(resumeId);
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
  const child = spawn(realCodex, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const childPid = child.pid || 0;

  const command = [realCodex, ...args];
  if (knownSessionId) {
    upsertLease({
      sessionId: knownSessionId,
      pid: childPid,
      cwd: process.cwd(),
      tty: process.env.TTY || "",
      command,
      startedAtMs,
      updatedAtMs: Date.now(),
      source: "tuiui-codex-lease",
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
        upsertLease({
          sessionId,
          pid: childPid,
          cwd: process.cwd(),
          tty: process.env.TTY || "",
          command,
          startedAtMs,
          updatedAtMs: Date.now(),
          source: "tuiui-codex-lease",
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
    removeLeaseForPid(sessionId, childPid);
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

async function terminateActiveLease(sessionId: string) {
  const lease = getActiveLease(sessionId);
  if (!lease) {
    return;
  }

  try {
    process.kill(lease.pid, "SIGTERM");
  } catch {
    removeLeaseForPid(sessionId, lease.pid);
    return;
  }

  const timeoutMs = Number(process.env.TUIUI_CODEX_LEASE_KILL_TIMEOUT_MS || 2_000);
  const stopped = await waitForPidExit(lease.pid, timeoutMs);
  if (!stopped) {
    try {
      process.kill(lease.pid, "SIGKILL");
    } catch {
    }
    await waitForPidExit(lease.pid, 1_000);
  }

  removeLeaseForPid(sessionId, lease.pid);
}

function getActiveLease(sessionId: string) {
  cleanupStaleLeases();
  return readRegistry().leases.find((lease) => lease.sessionId === sessionId && isProcessAlive(lease.pid));
}

function cleanupStaleLeases() {
  updateRegistry((registry) => ({
    leases: registry.leases.filter((lease) => isProcessAlive(lease.pid)),
  }));
}

function upsertLease(lease: Lease) {
  if (!lease.pid) {
    return;
  }

  updateRegistry((registry) => ({
    leases: [
      ...registry.leases.filter((candidate) => candidate.sessionId !== lease.sessionId || candidate.pid !== lease.pid),
      lease,
    ],
  }));
}

function removeLeaseForPid(sessionId: string, pid: number) {
  updateRegistry((registry) => ({
    leases: registry.leases.filter((lease) => lease.sessionId !== sessionId || lease.pid !== pid),
  }));
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

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as LeaseRegistry;
    return { leases: Array.isArray(parsed.leases) ? parsed.leases : [] };
  } catch {
    return { leases: [] };
  }
}

function updateRegistry(update: (registry: LeaseRegistry) => LeaseRegistry) {
  withRegistryLock(() => {
    const next = update(readRegistry());
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), `${JSON.stringify(next, null, 2)}\n`);
  });
}

function withRegistryLock(action: () => void) {
  const lockPath = `${registryPath()}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        action();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
      }
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST" || Date.now() > deadline) {
        throw error;
      }
      sleepSync(25);
    }
  }
}

function registryPath() {
  if (process.env.TUIUI_CODEX_LEASES_PATH) {
    return process.env.TUIUI_CODEX_LEASES_PATH;
  }

  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "tuiui", "codex-leases.json");
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

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
