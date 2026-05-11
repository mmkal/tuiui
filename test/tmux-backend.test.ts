import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "bun:test";
import { resolveSessionBackend, tmuxSessionNameForId } from "../src/tmux-backend.ts";

test("resolves Bun PTY as the default backend and tmux as an explicit opt-in", () => {
  expect(resolveSessionBackend("")).toBe("bun");
  expect(resolveSessionBackend("bun")).toBe("bun");
  expect(resolveSessionBackend("bun-pty")).toBe("bun");
  expect(resolveSessionBackend("tmux")).toBe("tmux");
  expect(tmuxSessionNameForId("tuiui_abc123")).toBe("tuiui_abc123");
  expect(tmuxSessionNameForId("abc/123")).toBe("tuiui_abc_123");
});

test("can opt into tmux sessions through the launch body and reconnect after server restart", async () => {
  if (!commandExists("tmux")) {
    return;
  }

  const rootDir = path.resolve(import.meta.dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-tmux-test-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const binDir = path.join(tempRoot, "bin");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "tmux-agent"), tmuxAgentSource, { mode: 0o755 });

  const port = await getFreePort();
  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH || ""].join(path.delimiter),
    HOME: path.join(tempRoot, "home"),
  };
  let server = await startTuiuiServer(rootDir, workspaceDir, env, port);
  let sessionId = "";

  try {
    const created = await fetchJson<{ id: string }>(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({
        command: "tmux-agent",
        args: [],
        cwd: workspaceDir,
        cols: 80,
        rows: 24,
        env: {},
        backend: "tmux",
      }),
    });
    sessionId = created.id;
    await expectSessionText(port, sessionId, "tmux ready");

    await fetchJson(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    expect(await pollSession(port, sessionId, (payload) => payload.cols === 100 && payload.rows === 30)).toMatchObject({
      id: sessionId,
      command: "tmux-agent",
      args: [],
      cwd: workspaceDir,
      cols: 100,
      rows: 30,
    });

    await fetchJson(`http://127.0.0.1:${port}/api/sessions/${sessionId}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "hello from tmux" }),
    });
    await expectSessionText(port, sessionId, "echo:hello from tmux");

    server.kill("SIGKILL");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    server = await startTuiuiServer(rootDir, workspaceDir, env, port);

    expect(await pollSession(port, sessionId, (payload) => payload.lifecycle === "running")).toMatchObject({
      id: sessionId,
      command: "tmux-agent",
      args: [],
      cwd: workspaceDir,
      lifecycle: "running",
    });
    await fetchJson(`http://127.0.0.1:${port}/api/sessions/${sessionId}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "after restart" }),
    });
    await expectSessionText(port, sessionId, "echo:after restart");
  } finally {
    if (sessionId) {
      await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/kill`, { method: "POST" }).catch(() => {});
      try {
        execFileSync("tmux", ["kill-session", "-t", tmuxSessionNameForId(sessionId)], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
      }
    }
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function startTuiuiServer(rootDir: string, cwd: string, env: NodeJS.ProcessEnv, port: number) {
  const server = spawn("bun", ["run", path.join(rootDir, "cli.ts"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  server.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return server;
      }
    } catch {
    }
    if (server.exitCode !== null) {
      throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill("SIGTERM");
  throw new Error(`timed out waiting for server\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function expectSessionText(port: number, sessionId: string, text: string) {
  const payload = await pollSession(port, sessionId, (candidate) => candidate.renderedText.includes(text));
  expect(payload.renderedText).toContain(text);
}

async function pollSession(port: number, sessionId: string, predicate: (payload: any) => boolean) {
  const deadline = Date.now() + 5_000;
  let payload: any = null;
  while (Date.now() < deadline) {
    payload = await fetchJson<any>(`http://127.0.0.1:${port}/api/sessions/${sessionId}`);
    if (predicate(payload)) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return payload;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return await response.json();
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

const tmuxAgentSource = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write("tmux ready\\r\\n");

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  while (/\\r|\\n/.test(pending)) {
    const match = pending.match(/\\r|\\n/);
    const index = match.index;
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (line) {
      process.stdout.write("echo:" + line + "\\r\\n");
    }
  }
});
setInterval(() => {}, 1_000);
`;
