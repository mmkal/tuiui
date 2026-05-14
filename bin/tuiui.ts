#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createCli, t } from "trpc-cli";
import { z } from "zod";
import { runCodexLease } from "../src/codex-lease.ts";

export const router = t.router({
  codex: t.procedure
    .meta({
      description: "Run Codex directly while leasing active session ownership to avoid split-brain resumes.",
      examples: [
        "tuiui codex",
        "tuiui codex --yolo",
        "tuiui codex resume 00000000-0000-0000-0000-000000000000",
      ],
    })
    .input(z.array(z.string()).default([]).describe("arguments forwarded to codex"))
    .handler(async ({ input }) => {
      process.exitCode = await runCodexLease(input || []);
    }),
});

export async function runTuiuiCli(argv = process.argv.slice(2)) {
  const cli = createCli({
    router,
    name: "tuiui",
    description: "Terminal UI helpers.",
  });
  const program = cli.buildProgram() as any;
  configureCodexPassThrough(program);
  await program.parseAsync(argv, { from: "user" });
}

function configureCodexPassThrough(program: any) {
  const codexCommand = program.commands.find((command: any) => command.name() === "codex");
  if (!codexCommand) {
    throw new Error("Expected trpc-cli to create a codex command.");
  }

  codexCommand.allowUnknownOption();
  codexCommand.helpOption(false);
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
  await runTuiuiCli();
}
