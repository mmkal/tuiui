import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { execFileSync } from "node:child_process";

export type TmuxSessionMetadata = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  createdAt: string;
  cols: number;
  rows: number;
};

export type TmuxBackendHandle = {
  name: "tmux";
  tmuxSessionName: string;
  exited: Promise<number | null>;
  initialCapture: string;
  write(input: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  dispose(): Promise<void>;
};

export type CreateTmuxBackendInput = TmuxSessionMetadata & {
  env: Record<string, string>;
  onData(chunk: string): void;
};

const tmuxMetadataOption = "@tuiui-metadata";

export function resolveSessionBackend(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "bun" || normalized === "pty" || normalized === "bun-pty") {
    return "bun" as const;
  }
  if (normalized === "tmux") {
    return "tmux" as const;
  }
  throw new Error(`unsupported session backend: ${value}`);
}

export type SessionBackendName = ReturnType<typeof resolveSessionBackend>;

export function tmuxSessionNameForId(id: string) {
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.startsWith("tuiui_") ? sanitized : `tuiui_${sanitized}`;
}

export function tmuxHasSession(id: string) {
  try {
    execFileSync("tmux", ["has-session", "-t", tmuxSessionNameForId(id)], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function readTmuxSessionMetadata(id: string): TmuxSessionMetadata | null {
  try {
    const encoded = execFileSync("tmux", ["show-option", "-qv", "-t", tmuxSessionNameForId(id), tmuxMetadataOption], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!encoded) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<TmuxSessionMetadata>;
    if (
      parsed.id !== id ||
      typeof parsed.command !== "string" ||
      !Array.isArray(parsed.args) ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.cols !== "number" ||
      typeof parsed.rows !== "number"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      command: parsed.command,
      args: parsed.args.map(String),
      cwd: parsed.cwd,
      createdAt: parsed.createdAt,
      cols: parsed.cols,
      rows: parsed.rows,
    };
  } catch {
    return null;
  }
}

export async function createTmuxBackend(input: CreateTmuxBackendInput): Promise<TmuxBackendHandle> {
  ensureTmuxAvailable();
  const tmuxSessionName = tmuxSessionNameForId(input.id);
  const fifoPath = path.join(os.tmpdir(), `${tmuxSessionName}.pipe`);
  fs.rmSync(fifoPath, { force: true });
  execFileSync("mkfifo", [fifoPath], { stdio: ["ignore", "ignore", "ignore"] });

  const reader = spawn("cat", [fifoPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const decoder = new StringDecoder("utf8");
  reader.stdout.on("data", (chunk: Buffer) => {
    input.onData(decoder.write(chunk));
  });
  reader.on("exit", () => {
    const flushed = decoder.end();
    if (flushed) {
      input.onData(flushed);
    }
  });

  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    tmuxSessionName,
    "-c",
    input.cwd,
    "-x",
    String(input.cols),
    "-y",
    String(input.rows),
    shellCommand(input.command, input.args, input.env),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  writeTmuxMetadata(input);
  execFileSync("tmux", ["pipe-pane", "-O", "-t", tmuxSessionName, `cat > ${shellQuote(fifoPath)}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let killed = false;
  const exited = waitForTmuxExit(tmuxSessionName, () => killed ? null : 0);

  return {
    name: "tmux",
    tmuxSessionName,
    exited,
    initialCapture: "",
    async write(text: string) {
      await sendTmuxInput(tmuxSessionName, text);
    },
    async resize(cols: number, rows: number) {
      execFileSync("tmux", ["resize-window", "-t", tmuxSessionName, "-x", String(cols), "-y", String(rows)], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    },
    async kill() {
      killed = true;
      execFileSync("tmux", ["kill-session", "-t", tmuxSessionName], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    },
    async dispose() {
      reader.kill("SIGTERM");
      fs.rmSync(fifoPath, { force: true });
    },
  };
}

export async function reconnectTmuxBackend(input: {
  id: string;
  onData(chunk: string): void;
}): Promise<{ metadata: TmuxSessionMetadata; handle: TmuxBackendHandle } | null> {
  ensureTmuxAvailable();
  const metadata = readTmuxSessionMetadata(input.id);
  if (!metadata || !tmuxHasSession(input.id)) {
    return null;
  }
  const tmuxSessionName = tmuxSessionNameForId(input.id);
  const fifoPath = path.join(os.tmpdir(), `${tmuxSessionName}.pipe`);
  fs.rmSync(fifoPath, { force: true });
  execFileSync("mkfifo", [fifoPath], { stdio: ["ignore", "ignore", "ignore"] });
  const reader = spawn("cat", [fifoPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const decoder = new StringDecoder("utf8");
  reader.stdout.on("data", (chunk: Buffer) => {
    input.onData(decoder.write(chunk));
  });
  reader.on("exit", () => {
    const flushed = decoder.end();
    if (flushed) {
      input.onData(flushed);
    }
  });
  execFileSync("tmux", ["pipe-pane", "-O", "-t", tmuxSessionName, `cat > ${shellQuote(fifoPath)}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let killed = false;
  const exited = waitForTmuxExit(tmuxSessionName, () => killed ? null : 0);

  return {
    metadata,
    handle: {
      name: "tmux",
      tmuxSessionName,
      exited,
      initialCapture: captureTmuxPane(tmuxSessionName),
      async write(text: string) {
        await sendTmuxInput(tmuxSessionName, text);
      },
      async resize(cols: number, rows: number) {
        execFileSync("tmux", ["resize-window", "-t", tmuxSessionName, "-x", String(cols), "-y", String(rows)], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      },
      async kill() {
        killed = true;
        execFileSync("tmux", ["kill-session", "-t", tmuxSessionName], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      },
      async dispose() {
        reader.kill("SIGTERM");
        fs.rmSync(fifoPath, { force: true });
      },
    },
  };
}

export function captureTmuxPane(tmuxSessionName: string) {
  return execFileSync("tmux", ["capture-pane", "-p", "-e", "-J", "-S", "-1000", "-t", tmuxSessionName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ensureTmuxAvailable() {
  execFileSync("tmux", ["-V"], { stdio: ["ignore", "ignore", "ignore"] });
}

function shellCommand(command: string, args: string[], env: Record<string, string>) {
  const envEntries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return ["env", ...envEntries, shellQuote(command), ...args.map(shellQuote)].join(" ");
}

function writeTmuxMetadata(input: TmuxSessionMetadata) {
  const encoded = Buffer.from(JSON.stringify({
    id: input.id,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    createdAt: input.createdAt,
    cols: input.cols,
    rows: input.rows,
  }), "utf8").toString("base64url");
  execFileSync("tmux", ["set-option", "-q", "-t", tmuxSessionNameForId(input.id), tmuxMetadataOption, encoded], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function sendTmuxInput(tmuxSessionName: string, text: string) {
  for (const token of tmuxInputTokens(text)) {
    if (token.literal) {
      execFileSync("tmux", ["send-keys", "-t", tmuxSessionName, "-l", token.value], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } else {
      execFileSync("tmux", ["send-keys", "-t", tmuxSessionName, token.value], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
  }
}

function tmuxInputTokens(text: string) {
  const tokens: Array<{ literal: boolean; value: string }> = [];
  let literal = "";
  const flushLiteral = () => {
    if (!literal) {
      return;
    }
    tokens.push({ literal: true, value: literal });
    literal = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] || "";
    const rest = text.slice(index);
    if (rest.startsWith("\x1b[A")) {
      flushLiteral();
      tokens.push({ literal: false, value: "Up" });
      index += 2;
      continue;
    }
    if (rest.startsWith("\x1b[B")) {
      flushLiteral();
      tokens.push({ literal: false, value: "Down" });
      index += 2;
      continue;
    }
    if (rest.startsWith("\x1b[C")) {
      flushLiteral();
      tokens.push({ literal: false, value: "Right" });
      index += 2;
      continue;
    }
    if (rest.startsWith("\x1b[D")) {
      flushLiteral();
      tokens.push({ literal: false, value: "Left" });
      index += 2;
      continue;
    }
    if (char === "\r" || char === "\n") {
      flushLiteral();
      tokens.push({ literal: false, value: "Enter" });
      continue;
    }
    if (char === "\x1b") {
      flushLiteral();
      tokens.push({ literal: false, value: "Escape" });
      continue;
    }
    if (char === "\t") {
      flushLiteral();
      tokens.push({ literal: false, value: "Tab" });
      continue;
    }
    if (char === "\x7f") {
      flushLiteral();
      tokens.push({ literal: false, value: "BSpace" });
      continue;
    }
    if (char === "\x03") {
      flushLiteral();
      tokens.push({ literal: false, value: "C-c" });
      continue;
    }
    if (char === "\x04") {
      flushLiteral();
      tokens.push({ literal: false, value: "C-d" });
      continue;
    }
    literal += char;
  }
  flushLiteral();
  return tokens;
}

function waitForTmuxExit(tmuxSessionName: string, exitCode: () => number | null) {
  return new Promise<number | null>((resolve) => {
    const interval = setInterval(() => {
      try {
        execFileSync("tmux", ["has-session", "-t", tmuxSessionName], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        clearInterval(interval);
        resolve(exitCode());
      }
    }, 250);
  });
}
