import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../cli.ts";

const rpcLink = new RPCLink({
  url: `${location.origin}/rpc`,
});

const orpc: RouterClient<AppRouter> = createORPCClient(rpcLink);

type OrpcJsonResult<T> =
  | { handled: true; value: T }
  | { handled: false };

export async function callOrpcJsonApi<T>(path: string, init: RequestInit = {}): Promise<OrpcJsonResult<T>> {
  if ((globalThis as { __tuiuiForceLegacyApi?: boolean }).__tuiuiForceLegacyApi) {
    return { handled: false };
  }

  const method = String(init.method || "GET").toUpperCase();
  const url = new URL(path, location.origin);

  if (method === "GET" && url.pathname === "/api/config") {
    return handled(await orpc.config() as T);
  }
  if (method === "GET" && url.pathname === "/api/cwd") {
    return handled(await orpc.cwd() as T);
  }
  if (method === "GET" && url.pathname === "/api/commands") {
    return handled(await orpc.commands() as T);
  }
  if (method === "GET" && url.pathname === "/api/agent-sessions/recent") {
    return handled(await orpc.agentSessions.recent() as T);
  }
  if (method === "GET" && url.pathname === "/api/codex-sessions/recent") {
    return handled(await orpc.codexSessions.recent() as T);
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    return handled(await orpc.sessions.list() as T);
  }
  if (method === "POST" && url.pathname === "/api/sessions") {
    return handled(await orpc.sessions.create(jsonBody(init)) as T);
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    return { handled: false };
  }

  const sessionId = match[1] || "";
  const action = match[2] || "";
  if (method === "GET" && !action) {
    return handled(await orpc.sessions.get({ sessionId }) as T);
  }
  if (method === "GET" && action === "recovery") {
    return handled(await orpc.sessions.recovery({ sessionId }) as T);
  }
  if (method === "POST" && action === "recover") {
    return handled(await orpc.sessions.recover({ sessionId }) as T);
  }
  if (method === "POST" && action === "archive") {
    return handled(await orpc.sessions.archive({ sessionId }) as T);
  }
  if (method === "POST" && action === "send") {
    return handled(await orpc.sessions.send({ sessionId, ...jsonBody(init) }) as T);
  }
  if (method === "POST" && action === "key") {
    return handled(await orpc.sessions.key({ sessionId, ...jsonBody(init) }) as T);
  }
  if (method === "POST" && action === "resize") {
    return handled(await orpc.sessions.resize({ sessionId, ...jsonBody(init) }) as T);
  }
  if (method === "POST" && action === "kill") {
    return handled(await orpc.sessions.kill({ sessionId }) as T);
  }
  if (method === "POST" && action === "sdk-refresh") {
    return handled(await orpc.sessions.sdkRefresh({ sessionId }) as T);
  }
  if (method === "POST" && action === "sdk-summarize") {
    return handled(await orpc.sessions.sdkSummarize({ sessionId }) as T);
  }

  return { handled: false };
}

function handled<T>(value: T): OrpcJsonResult<T> {
  return { handled: true, value };
}

function jsonBody(init: RequestInit) {
  if (typeof init.body === "string" && init.body) {
    return JSON.parse(init.body) as Record<string, unknown>;
  }
  return {};
}
