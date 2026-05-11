export type ChordBinary = "" | "codex" | "opencode" | "claude";

export type ChordStep = {
  text: string;
  submit: boolean;
};

export type ChordPreset = {
  id: string;
  label: string;
  sequence: string;
  binaries: ChordBinary[];
};

type ResolvedKey = {
  seq: string;
  csi: string;
};

const commonBinary: ChordBinary = "";

export const chordPresets: ChordPreset[] = [
  { id: "common-tab", label: "Tab", sequence: "tab", binaries: [commonBinary] },
  { id: "common-up", label: "Up", sequence: "up", binaries: [commonBinary] },
  { id: "common-down", label: "Down", sequence: "down", binaries: [commonBinary] },
  { id: "common-left", label: "Left", sequence: "left", binaries: [commonBinary] },
  { id: "common-right", label: "Right", sequence: "right", binaries: [commonBinary] },
  { id: "common-interrupt", label: "Ctrl-C", sequence: "ctrl+c", binaries: [commonBinary] },
  { id: "codex-escape", label: "Esc", sequence: "esc", binaries: ["codex"] },
  { id: "codex-newline", label: "Ctrl-J", sequence: "ctrl+j", binaries: ["codex"] },
  { id: "opencode-back", label: "Esc Esc", sequence: "esc;esc", binaries: ["opencode"] },
  { id: "opencode-newline", label: "Ctrl-J", sequence: "ctrl+j", binaries: ["opencode"] },
  { id: "claude-escape", label: "Esc", sequence: "esc", binaries: ["claude"] },
  { id: "claude-shift-tab", label: "Shift-Tab", sequence: "shift+tab", binaries: ["claude"] },
  { id: "claude-newline", label: "Ctrl-J", sequence: "ctrl+j", binaries: ["claude"] },
];

export function detectChordBinary(command: string, args: string[], provider: string): ChordBinary {
  if (provider === "codex" || provider === "opencode" || provider === "claude") {
    return provider;
  }
  const commandName = basename(command).toLowerCase();
  if (commandName === "codex" || commandName === "opencode" || commandName === "claude") {
    return commandName;
  }
  const searchable = [commandName, ...args].join(" ").toLowerCase();
  if (/\bcodex\b/.test(searchable)) {
    return "codex";
  }
  if (/\bopencode\b/.test(searchable)) {
    return "opencode";
  }
  if (/\bclaude\b/.test(searchable)) {
    return "claude";
  }
  return "";
}

export function presetsForBinary(binary: ChordBinary) {
  const seen = new Set<string>();
  const selected: ChordPreset[] = [];
  for (const preset of chordPresets) {
    if (!preset.binaries.includes(binary) && !preset.binaries.includes(commonBinary)) {
      continue;
    }
    const key = preset.sequence.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(preset);
  }
  return selected.sort((left, right) => {
    const leftSpecific = left.binaries.includes(binary) && binary ? 0 : 1;
    const rightSpecific = right.binaries.includes(binary) && binary ? 0 : 1;
    return leftSpecific - rightSpecific;
  });
}

export function parseChordSteps(input: string): ChordStep[] {
  const statements = input.split(";").map((statement) => statement.trim()).filter(Boolean);
  if (!statements.length) {
    throw new Error("Chord sequence is empty");
  }
  return statements.map((statement) => ({ text: parseChordStatement(statement), submit: false }));
}

export function resolveNamedKeySequence(key: string): string {
  if (/^(?:(?:ctrl|control|shift|alt|cmd|meta|opt)[+\-])+.+$/i.test(key)) {
    return parseChordStatement(key);
  }
  const resolved = resolveKeyName(key.toLowerCase());
  return resolved ? resolved.seq : key;
}

function parseChordStatement(statement: string): string {
  const modifierMatch = statement.match(/^((?:(?:ctrl|control|shift|alt|cmd|meta|opt)[+\-])+)(.+)$/i);
  if (!modifierMatch) {
    return resolveNamedKeySequence(statement);
  }

  const mods = new Set(
    modifierMatch[1]!
      .replace(/[+\-]$/, "")
      .split(/[+\-]/)
      .map((mod) => normalizeModifier(mod)),
  );
  const rest = modifierMatch[2]!;
  const wholeKey = resolveKeyName(rest.toLowerCase());
  if (wholeKey) {
    return applyModifiers(wholeKey, mods);
  }

  const firstKey = resolveKeyName(rest[0]!.toLowerCase());
  const tail = rest.slice(1);
  if (!firstKey) {
    return rest;
  }
  return applyModifiers(firstKey, mods) + tail;
}

function resolveKeyName(key: string): ResolvedKey | null {
  switch (key) {
    case "tab":
      return { seq: "\t", csi: "" };
    case "esc":
    case "escape":
      return { seq: "\x1b", csi: "" };
    case "enter":
    case "return":
      return { seq: "\r", csi: "" };
    case "space":
      return { seq: " ", csi: "" };
    case "backspace":
      return { seq: "\x7f", csi: "" };
    case "delete":
    case "del":
      return { seq: "\x1b[3~", csi: "3~" };
    case "up":
      return { seq: "\x1b[A", csi: "A" };
    case "down":
      return { seq: "\x1b[B", csi: "B" };
    case "left":
      return { seq: "\x1b[D", csi: "D" };
    case "right":
      return { seq: "\x1b[C", csi: "C" };
    case "home":
      return { seq: "\x1b[H", csi: "H" };
    case "end":
      return { seq: "\x1b[F", csi: "F" };
    case "pageup":
    case "pgup":
      return { seq: "\x1b[5~", csi: "5~" };
    case "pagedown":
    case "pgdn":
      return { seq: "\x1b[6~", csi: "6~" };
    case "insert":
    case "ins":
      return { seq: "\x1b[2~", csi: "2~" };
    default:
      if (key.length === 1) {
        return { seq: key, csi: "" };
      }
      return null;
  }
}

function applyModifiers(base: ResolvedKey, mods: Set<string>) {
  if (mods.size === 0) {
    return base.seq;
  }

  const modNum = 1 + (mods.has("shift") ? 1 : 0) + (mods.has("alt") ? 2 : 0) + (mods.has("ctrl") ? 4 : 0);

  if (base.csi) {
    if (base.csi.includes("~")) {
      return `\x1b[${base.csi.replace("~", "")};${modNum}~`;
    }
    return `\x1b[1;${modNum}${base.csi}`;
  }

  if (mods.has("ctrl") && /^[a-z]$/.test(base.seq)) {
    let seq = String.fromCharCode(base.seq.toUpperCase().charCodeAt(0) - 64);
    if (mods.has("alt")) {
      seq = "\x1b" + seq;
    }
    return seq;
  }

  if (mods.has("ctrl") && base.seq === "/") {
    return String.fromCharCode(31);
  }

  if (mods.has("shift") && base.seq === "\t") {
    return "\x1b[Z";
  }

  if (mods.has("shift") && base.seq === "\r") {
    return "\x1b[13;2u";
  }

  if (mods.has("alt") && !mods.has("ctrl") && !mods.has("shift")) {
    return "\x1b" + base.seq;
  }

  return base.seq;
}

function normalizeModifier(modifier: string) {
  const lower = modifier.toLowerCase();
  if (lower === "cmd" || lower === "meta" || lower === "opt") {
    return "alt";
  }
  if (lower === "control") {
    return "ctrl";
  }
  return lower;
}

function basename(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}
