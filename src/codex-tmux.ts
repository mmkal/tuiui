#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WATCH_ARG = "--watch-session-id";
const CODEX_SESSION_ID_OPTION = "@codex-session-id";
const WRAPPER_OPTION = "@codex-tmux-wrapper";

export async function runCodexTmuxCli(args = process.argv.slice(2)) {
  if (args[0] === WATCH_ARG) {
    process.exitCode = await runWatcher(args[1]);
    return;
  }

  process.exitCode = await runCodexTmux(args);
}

export async function runCodexTmux(args: string[]) {
  const realCodex = findRealCodex();
  if (!realCodex) {
    console.error("codex-tmux: could not find the real codex binary. Set REALCODEX or CODEX_TMUX_CODEX_BIN.");
    return 127;
  }

  if (process.env.CODEX_TMUX === "0" || !hasCommand("tmux")) {
    return runForeground(realCodex, args);
  }

  const resumeId = findResumeId(args);
  if (resumeId) {
    const existingSession = findTmuxSessionByCodexId(resumeId);
    if (existingSession) {
      return attachTmux(existingSession);
    }
  }

  const tmuxSession = newTmuxSessionName();
  const command = shellCommand([realCodex, ...args]);
  startWatcher(tmuxSession, command);

  if (process.env.TMUX) {
    const created = spawnSync("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", process.cwd(), command], {
      stdio: "inherit",
    });
    if (created.status !== 0) {
      return created.status || 1;
    }
    return attachTmux(tmuxSession);
  }

  const result = spawnSync("tmux", ["new-session", "-s", tmuxSession, "-c", process.cwd(), command], {
    stdio: "inherit",
  });
  return result.status || 0;
}

async function runWatcher(sessionName: string | undefined) {
  if (!sessionName) {
    return 2;
  }

  await watchSessionId(sessionName);
  return 0;
}

function findRealCodex() {
  const configured = process.env.REALCODEX || process.env.CODEX_TMUX_CODEX_BIN;
  if (configured) {
    return configured;
  }

  const found = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8" });
  if (found.status !== 0) {
    return "";
  }

  return found.stdout.trim();
}

function hasCommand(command: string) {
  return spawnSync("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`]).status === 0;
}

function runForeground(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.signal) {
    return 128 + signalNumber(result.signal);
  }
  return result.status || 0;
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

function findTmuxSessionByCodexId(codexSessionId: string) {
  const listed = spawnSync("tmux", ["list-sessions", "-F", `#{session_name}\t#{${CODEX_SESSION_ID_OPTION}}`], {
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    return "";
  }

  for (const line of listed.stdout.split("\n")) {
    const [sessionName, storedCodexId] = line.split("\t");
    if (sessionName && storedCodexId === codexSessionId) {
      return sessionName;
    }
  }

  return "";
}

function newTmuxSessionName() {
  const prefix = process.env.CODEX_TMUX_PREFIX || "codex";
  const cwd = slug(basename(process.cwd()) || "session");
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${slug(prefix)}-${cwd}-${stamp}-${process.pid}`;
}

function slug(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "codex";
}

function shellCommand(parts: string[]) {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function setTmuxOption(sessionName: string, optionName: string, value: string) {
  spawnSync("tmux", ["set-option", "-q", "-t", sessionName, optionName, value], { stdio: "ignore" });
}

function startWatcher(sessionName: string, command: string) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), WATCH_ARG, sessionName], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_TMUX_WATCH_CWD: process.cwd(),
      CODEX_TMUX_WATCH_COMMAND: command,
    },
  });
  child.unref();
}

async function watchSessionId(sessionName: string) {
  const attempts = Number(process.env.CODEX_TMUX_DISCOVERY_ATTEMPTS || 100);
  const intervalMs = Number(process.env.CODEX_TMUX_DISCOVERY_INTERVAL_MS || 100);
  let sawSession = false;
  let recordedMetadata = false;

  for (let i = 0; i < attempts; i += 1) {
    if (!tmuxSessionExists(sessionName)) {
      if (sawSession) {
        return;
      }
      await delay(intervalMs);
      continue;
    }

    sawSession = true;
    if (!recordedMetadata) {
      setTmuxOption(sessionName, WRAPPER_OPTION, "1");
      setTmuxOption(sessionName, "@codex-cwd", process.env.CODEX_TMUX_WATCH_CWD || "");
      setTmuxOption(sessionName, "@codex-command", process.env.CODEX_TMUX_WATCH_COMMAND || "");
      recordedMetadata = true;
    }

    const codexSessionId = captureCodexSessionId(sessionName);
    if (codexSessionId) {
      setTmuxOption(sessionName, CODEX_SESSION_ID_OPTION, codexSessionId);
      setTmuxOption(sessionName, "@codex-session-id-discovered-at", new Date().toISOString());
      return;
    }

    await delay(intervalMs);
  }
}

function tmuxSessionExists(sessionName: string) {
  return spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" }).status === 0;
}

function captureCodexSessionId(sessionName: string) {
  const captured = spawnSync("tmux", ["capture-pane", "-p", "-S", "-200", "-t", sessionName], {
    encoding: "utf8",
  });
  if (captured.status !== 0) {
    return "";
  }

  const match = captured.stdout.match(/session[ _-]?id:\s*([0-9a-fA-F-]{36})/i);
  return match ? match[1] : "";
}

function attachTmux(sessionName: string) {
  const tmuxArgs = process.env.TMUX ? ["switch-client", "-t", sessionName] : ["attach-session", "-t", sessionName];
  const result = spawnSync("tmux", tmuxArgs, { stdio: "inherit" });
  if (result.signal) {
    return 128 + signalNumber(result.signal);
  }
  return result.status || 0;
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

function isDirectRun(metaUrl: string, argvPath: string | undefined) {
  if (!argvPath) {
    return false;
  }

  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return modulePath === argvPath;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await runCodexTmuxCli();
}
