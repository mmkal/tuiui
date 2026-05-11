import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import {
  isBlankIntroFrame,
  isNearlyWhiteFrame,
  parseSignalStatsFrames,
  readVideoSignalStats,
} from "../spec/plugins/video-mode.ts";

test("parses ffmpeg signalstats frame metadata", () => {
  const frames = parseSignalStatsFrames([
    "frame:0    pts:0       pts_time:0",
    "lavfi.signalstats.YMIN=235",
    "lavfi.signalstats.YAVG=235",
    "lavfi.signalstats.YMAX=235",
    "lavfi.signalstats.SATMIN=0",
    "lavfi.signalstats.SATAVG=0",
    "lavfi.signalstats.SATMAX=0",
    "frame:1    pts:1       pts_time:0.1",
    "lavfi.signalstats.YMIN=29",
    "lavfi.signalstats.YAVG=29",
    "lavfi.signalstats.YMAX=192",
    "lavfi.signalstats.SATMIN=0",
    "lavfi.signalstats.SATAVG=56",
    "lavfi.signalstats.SATMAX=120",
  ].join("\n"));

  expect(frames).toEqual([
    { time: 0, yMin: 235, yMax: 235, yAvg: 235, satMin: 0, satAvg: 0, satMax: 0 },
    { time: 0.1, yMin: 29, yMax: 192, yAvg: 29, satMin: 0, satAvg: 56, satMax: 120 },
  ]);
  expect(isNearlyWhiteFrame(frames[0]!)).toBe(true);
  expect(isNearlyWhiteFrame(frames[1]!)).toBe(false);
});

const testWithFfmpeg = commandExists("ffmpeg") ? test : test.skip;

testWithFfmpeg("trims leading white frames from a Playwright-style WebM", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-video-mode-"));
  try {
    const videoPath = path.join(tempRoot, "video.webm");
    writeWhiteThenPatternWebm(videoPath);

    const before = await readVideoSignalStats(videoPath, { scanSeconds: 0.5, scanFps: 10 });
    expect(isNearlyWhiteFrame(before[0]!)).toBe(true);

    const output = execFileSync("bun", ["spec/plugins/video-mode.ts", "trim", videoPath], {
      cwd: path.resolve(import.meta.dir, ".."),
      encoding: "utf8",
    });
    expect(output).toContain("trimmed");

    const after = await readVideoSignalStats(videoPath, { scanSeconds: 0.4, scanFps: 10 });
    expect(isNearlyWhiteFrame(after[0]!)).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

testWithFfmpeg("trims leading dark flat frames before the first contentful frame", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-video-mode-"));
  try {
    const videoPath = path.join(tempRoot, "video.webm");
    writeDarkThenPatternWebm(videoPath);

    const before = await readVideoSignalStats(videoPath, { scanSeconds: 0.4, scanFps: 10 });
    expect(isBlankIntroFrame(before[0]!)).toBe(true);

    const output = execFileSync("bun", ["spec/plugins/video-mode.ts", "trim", videoPath], {
      cwd: path.resolve(import.meta.dir, ".."),
      encoding: "utf8",
    });
    expect(output).toContain("trimmed");

    const after = await readVideoSignalStats(videoPath, { scanSeconds: 0.4, scanFps: 10 });
    expect(isBlankIntroFrame(after[0]!)).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function writeWhiteThenPatternWebm(videoPath: string) {
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=white:size=160x90:rate=30:d=0.3",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:d=0.7",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-b:v",
    "0",
    "-crf",
    "32",
    "-y",
    videoPath,
  ]);
}

function writeDarkThenPatternWebm(videoPath: string) {
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=#202020:size=160x90:rate=30:d=0.3",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:d=0.7",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-b:v",
    "0",
    "-crf",
    "32",
    "-y",
    videoPath,
  ]);
}

function commandExists(command: string) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  return paths.some((dir) => fs.existsSync(path.join(dir, command)));
}
