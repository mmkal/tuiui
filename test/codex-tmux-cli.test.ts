import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("tuiui codex forwards Codex flags instead of treating them as tuiui options", () => {
  using fixture = createFakeCodex();

  const args = ["codex", "--help", "--yolo", "resume", "abc123", "--watch-session-id"];
  const result = spawnSync("node", [path.resolve("bin/tuiui.ts"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ARGS_PATH: fixture.argsPath,
      CODEX_TMUX: "0",
      REALCODEX: fixture.codexPath,
    },
  });

  expect(result).toMatchObject({ status: 0 });
  expect(JSON.parse(fs.readFileSync(fixture.argsPath, "utf8"))).toEqual(args.slice(1));

  fs.rmSync(fixture.argsPath);
  const noArgResult = spawnSync("node", [path.resolve("bin/tuiui.ts"), "codex"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ARGS_PATH: fixture.argsPath,
      CODEX_TMUX: "0",
      REALCODEX: fixture.codexPath,
    },
  });

  expect(noArgResult).toMatchObject({ status: 0 });
  expect(JSON.parse(fs.readFileSync(fixture.argsPath, "utf8"))).toEqual([]);
});

function createFakeCodex() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-codex-cli-"));
  const codexPath = path.join(root, "codex.js");
  const argsPath = path.join(root, "args.json");

  fs.writeFileSync(
    codexPath,
    `#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(process.env.CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
`,
    { mode: 0o755 },
  );

  return {
    argsPath,
    codexPath,
    [Symbol.dispose]() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
