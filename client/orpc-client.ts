import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../cli.ts";

const rpcLink = new RPCLink({
  url: `${location.origin}/rpc`,
});

export const clientApi: RouterClient<AppRouter> = createORPCClient(rpcLink);
