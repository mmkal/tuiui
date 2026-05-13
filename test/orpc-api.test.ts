import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { expect, test } from "bun:test";
import type { AppRouter } from "../cli.ts";

test("serves JSON procedures through ORPC while keeping legacy api routes", async () => {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-orpc-api-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "orpc-agent"), longRunningAgentSource(), { mode: 0o755 });

  const port = await getFreePort();
  const server = await startTuiuiServer(rootDir, workspace, {
    ...process.env,
    PATH: [binDir, process.env.PATH || ""].join(path.delimiter),
    HOME: path.join(workspace, "home"),
    TUIUI_STATE_DB: path.join(workspace, "state", "tuiui.sqlite"),
  }, port);

  try {
    const client: RouterClient<AppRouter> = createORPCClient(new RPCLink({ url: `http://127.0.0.1:${port}/rpc` }));
    expect(await client.cwd()).toMatchObject({ cwd: fs.realpathSync(workspace) });
    await expect(await fetchJson<any[]>(`http://127.0.0.1:${port}/api/commands`)).toEqual(await client.commands());

    const created = await client.sessions.create({
      command: "orpc-agent",
      args: [],
      cwd: workspace,
      cols: 80,
      rows: 24,
      env: {},
    });
    await expect(created).toMatchObject({ url: `http://127.0.0.1:${port}/sessions/${created.id}` });
    await poll(async () => {
      return (await client.sessions.get({ sessionId: created.id })).renderedText;
    }, (text) => text.includes("orpc ready"));

    expect(await client.sessions.send({ sessionId: created.id, text: "hello", submit: true })).toMatchObject({ ok: true });
    const renderedText = await poll(async () => {
      return (await client.sessions.get({ sessionId: created.id })).renderedText;
    }, (text) => text.includes("echo:hello"));
    expect(renderedText).toContain("echo:hello");

    await expect(await fetchJson<any>(`http://127.0.0.1:${port}/api/sessions/${created.id}`)).toMatchObject({
      id: created.id,
      command: "orpc-agent",
    });
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server);
    fs.rmSync(workspace, { recursive: true, force: true });
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

async function fetchJson<T>(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

async function poll<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (Date.now() < deadline) {
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
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

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
}

function longRunningAgentSource() {
  return `#!/usr/bin/env node
process.stdout.write("orpc ready\\r\\n");
process.stdin.on("data", (chunk) => process.stdout.write("echo:" + chunk.toString("utf8")));
setInterval(() => {}, 1_000);
`;
}
