import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../cli.ts";

const rpcLink = new RPCLink({
  url: `${location.origin}/rpc`,
});

export const orpcClient: RouterClient<AppRouter> = createORPCClient(rpcLink);

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
    return handled(await orpcClient.config() as T);
  }
  if (method === "GET" && url.pathname === "/api/cwd") {
    return handled(await orpcClient.cwd() as T);
  }
  if (method === "GET" && url.pathname === "/api/commands") {
    return handled(await orpcClient.commands() as T);
  }
  if (method === "GET" && url.pathname === "/api/agent-sessions/recent") {
    return handled(await orpcClient.agentSessions.recent() as T);
  }
  if (method === "GET" && url.pathname === "/api/codex-sessions/recent") {
    return handled(await orpcClient.codexSessions.recent() as T);
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    return handled(await orpcClient.sessions.list() as T);
  }
  if (method === "POST" && url.pathname === "/api/sessions") {
    return handled(await orpcClient.sessions.create(jsonBody(init)) as T);
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    return { handled: false };
  }

  const sessionId = match[1] || "";
  const action = match[2] || "";
  if (method === "GET" && !action) {
    return handled(await orpcClient.sessions.get({ sessionId }) as T);
  }
  if (method === "GET" && action === "recovery") {
    return handled(await orpcClient.sessions.recovery({ sessionId }) as T);
  }
  if (method === "POST" && action === "recover") {
    return handled(await orpcClient.sessions.recover({ sessionId }) as T);
  }
  if (method === "POST" && action === "archive") {
    return handled(await orpcClient.sessions.archive({ sessionId }) as T);
  }
  if (method === "POST" && action === "send") {
    return handled(await orpcClient.sessions.send({ sessionId, ...jsonBody(init) }) as T);
  }
  if (method === "POST" && action === "key") {
    return handled(await orpcClient.sessions.key({ sessionId, ...jsonBody(init) }) as T);
  }
  if (method === "POST" && action === "resize") {
    return handled(await orpcClient.sessions.resize({ sessionId, ...jsonBody(init) }) as T);
  }
  if (method === "POST" && action === "kill") {
    return handled(await orpcClient.sessions.kill({ sessionId }) as T);
  }
  if (method === "POST" && action === "sdk-refresh") {
    return handled(await orpcClient.sessions.sdkRefresh({ sessionId }) as T);
  }
  if (method === "POST" && action === "sdk-summarize") {
    return handled(await orpcClient.sessions.sdkSummarize({ sessionId }) as T);
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
