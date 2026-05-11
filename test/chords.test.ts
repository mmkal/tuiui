import { expect, test } from "bun:test";
import { detectChordBinary, parseChordSteps, presetsForBinary, resolveNamedKeySequence } from "../src/chords.ts";

test("parses named keys, modifiers, and spelled-out chord sequences", () => {
  expect(parseChordSteps("esc;esc")).toMatchObject([
    { text: "\x1b", submit: false },
    { text: "\x1b", submit: false },
  ]);
  expect(parseChordSteps("/model;enter")).toMatchObject([
    { text: "/model", submit: false },
    { text: "\r", submit: false },
  ]);
  expect(parseChordSteps("ctrl+j")).toMatchObject([{ text: "\n", submit: false }]);
  expect(parseChordSteps("ctrl+xr")).toMatchObject([{ text: "\x18r", submit: false }]);
  expect(parseChordSteps("shift+tab")).toMatchObject([{ text: "\x1b[Z", submit: false }]);
  expect(resolveNamedKeySequence("ctrl+c")).toBe("\x03");
});

test("selects binary-specific presets before common key presets", () => {
  expect(detectChordBinary("/tmp/fake/codex", [], "")).toBe("codex");
  expect(detectChordBinary("node", ["fakeagent", "opencode"], "")).toBe("opencode");
  expect(presetsForBinary("opencode").slice(0, 2)).toMatchObject([
    { label: "Esc Esc", sequence: "esc;esc" },
    { label: "Ctrl-J", sequence: "ctrl+j" },
  ]);
  expect(presetsForBinary("claude").slice(0, 2)).toMatchObject([
    { label: "Esc", sequence: "esc" },
    { label: "Shift-Tab", sequence: "shift+tab" },
  ]);
});
