// Copied from ../iterate/spec/plugins/video-mode.ts.
// Local changes: adds a CLI/helper to trim Playwright's leading blank white video frames.
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Locator } from "@playwright/test";
import type { Plugin, OverrideableMethod } from "../playwright-plugin.ts";

const execFileAsync = promisify(execFile);

export type VideoModeOptions = {
  /** Pause duration before action (ms). Default: 1000 */
  pauseBefore?: number;
  /** Pause duration after test (ms). Default: 3000 */
  pauseAfterTest?: number;
  /** Highlight style. Default: '3px solid gold' */
  highlightStyle?: string;
  /** Methods to skip highlighting. Default: ['waitFor'] */
  skipMethods?: OverrideableMethod[];
};

export type VideoSignalStatsFrame = {
  time: number;
  yMin: number;
  yMax: number;
  yAvg: number;
  satMin: number;
  satAvg: number;
  satMax: number;
};

export type TrimLeadingWhiteFramesOptions = {
  ffmpegPath?: string;
  scanSeconds?: number;
  scanFps?: number;
  whiteYMin?: number;
  whiteYAvg?: number;
  maxWhiteSatAvg?: number;
  maxFlatLumaRange?: number;
  maxFlatSatRange?: number;
  crf?: number;
};

export type TrimLeadingWhiteFramesResult = {
  path: string;
  trimmed: boolean;
  trimStart: number;
  reason: string;
};

/** Highlight element, pause, return disposable that unhighlights */
const setupHighlight = async (locator: Locator, style: string, pauseMs: number) => {
  try {
    await locator.evaluate((el, s) => {
      const prev = el.getAttribute("style") || "";
      el.setAttribute("data-video-prev-style", prev);
      el.setAttribute(
        "style",
        `${prev}; outline: ${s} !important; outline-offset: 2px !important;`,
      );
    }, style);
  } catch {
    // Element may not be ready yet, ignore
  }
  await new Promise((resolve) => setTimeout(resolve, pauseMs));

  return {
    [Symbol.dispose]: () => {
      // Fire-and-forget cleanup - don't wait for it
      locator
        .evaluate((el) => {
          const prev = el.getAttribute("data-video-prev-style");
          if (typeof prev === "string") {
            el.setAttribute("style", prev);
            el.removeAttribute("data-video-prev-style");
          }
        })
        .catch(() => {
          // Element may be gone or not actionable, ignore
        });
    },
  };
};

export async function trimLeadingWhiteFrames(
  videoPath: string,
  options: TrimLeadingWhiteFramesOptions = {},
): Promise<TrimLeadingWhiteFramesResult> {
  const resolvedPath = path.resolve(videoPath);
  const frames = await readVideoSignalStats(resolvedPath, options);
  if (!frames.length) {
    return { path: resolvedPath, trimmed: false, trimStart: 0, reason: "no frames were readable" };
  }
  if (!isBlankIntroFrame(frames[0]!, options)) {
    return { path: resolvedPath, trimmed: false, trimStart: 0, reason: "first frame is contentful" };
  }

  const firstContentful = frames.find((frame) => !isBlankIntroFrame(frame, options));
  if (!firstContentful) {
    return { path: resolvedPath, trimmed: false, trimStart: 0, reason: "all sampled frames are blank" };
  }

  await rewriteVideoFrom(resolvedPath, firstContentful.time, options);
  return {
    path: resolvedPath,
    trimmed: true,
    trimStart: firstContentful.time,
    reason: "trimmed leading blank frames",
  };
}

export async function readVideoSignalStats(
  videoPath: string,
  options: TrimLeadingWhiteFramesOptions = {},
) {
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const scanSeconds = typeof options.scanSeconds === "number" ? options.scanSeconds : 2;
  const scanFps = typeof options.scanFps === "number" ? options.scanFps : 30;
  const { stdout } = await execFileAsync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-t",
    String(scanSeconds),
    "-vf",
    `fps=${scanFps},signalstats,metadata=print:file=-`,
    "-an",
    "-f",
    "null",
    "-",
  ], { maxBuffer: 10 * 1024 * 1024 });
  return parseSignalStatsFrames(stdout);
}

export function parseSignalStatsFrames(output: string): VideoSignalStatsFrame[] {
  const frames: Partial<VideoSignalStatsFrame>[] = [];
  let current: Partial<VideoSignalStatsFrame> | null = null;

  for (const line of output.split(/\r?\n/)) {
    const frameMatch = line.match(/^frame:\s*\d+.*pts_time:([0-9.]+)/);
    if (frameMatch) {
      if (current) {
        frames.push(current);
      }
      current = { time: Number(frameMatch[1]) };
      continue;
    }

    if (!current) {
      continue;
    }

    const statMatch = line.match(/^lavfi\.signalstats\.(YMIN|YAVG|YMAX|SATMIN|SATAVG|SATMAX)=([0-9.]+)/);
    if (!statMatch) {
      continue;
    }
    const value = Number(statMatch[2]);
    if (statMatch[1] === "YMIN") {
      current.yMin = value;
    } else if (statMatch[1] === "YAVG") {
      current.yAvg = value;
    } else if (statMatch[1] === "YMAX") {
      current.yMax = value;
    } else if (statMatch[1] === "SATMIN") {
      current.satMin = value;
    } else if (statMatch[1] === "SATAVG") {
      current.satAvg = value;
    } else {
      current.satMax = value;
    }
  }

  if (current) {
    frames.push(current);
  }

  return frames.filter((frame): frame is VideoSignalStatsFrame => {
    return Number.isFinite(frame.time)
      && Number.isFinite(frame.yMin)
      && Number.isFinite(frame.yMax)
      && Number.isFinite(frame.yAvg)
      && Number.isFinite(frame.satMin)
      && Number.isFinite(frame.satAvg)
      && Number.isFinite(frame.satMax);
  });
}

export function isNearlyWhiteFrame(frame: VideoSignalStatsFrame, options: TrimLeadingWhiteFramesOptions = {}) {
  const whiteYMin = typeof options.whiteYMin === "number" ? options.whiteYMin : 228;
  const whiteYAvg = typeof options.whiteYAvg === "number" ? options.whiteYAvg : 232;
  const maxWhiteSatAvg = typeof options.maxWhiteSatAvg === "number" ? options.maxWhiteSatAvg : 4;
  return frame.yMin >= whiteYMin && frame.yAvg >= whiteYAvg && frame.satAvg <= maxWhiteSatAvg;
}

export function isBlankIntroFrame(frame: VideoSignalStatsFrame, options: TrimLeadingWhiteFramesOptions = {}) {
  const maxFlatLumaRange = typeof options.maxFlatLumaRange === "number" ? options.maxFlatLumaRange : 10;
  const maxFlatSatRange = typeof options.maxFlatSatRange === "number" ? options.maxFlatSatRange : 10;
  const lumaRange = frame.yMax - frame.yMin;
  const saturationRange = frame.satMax - frame.satMin;
  return isNearlyWhiteFrame(frame, options)
    || (lumaRange <= maxFlatLumaRange && saturationRange <= maxFlatSatRange);
}

async function rewriteVideoFrom(videoPath: string, trimStart: number, options: TrimLeadingWhiteFramesOptions) {
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const crf = typeof options.crf === "number" ? options.crf : 32;
  const tempPath = path.join(
    path.dirname(videoPath),
    `.video-mode-trim-${process.pid}-${Date.now()}${path.extname(videoPath) || ".webm"}`,
  );
  try {
    await execFileAsync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-ss",
      trimStart.toFixed(3),
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-b:v",
      "0",
      "-crf",
      String(crf),
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      tempPath,
    ], { maxBuffer: 10 * 1024 * 1024 });
    await fs.rename(tempPath, videoPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function findVideos(target: string): Promise<string[]> {
  const stats = await fs.stat(target);
  if (stats.isFile()) {
    return [target];
  }
  if (!stats.isDirectory()) {
    return [];
  }

  const found: string[] = [];
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findVideos(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".webm")) {
      found.push(entryPath);
    }
  }
  return found;
}

async function runCli(argv: string[]) {
  const trimIndex = argv.indexOf("trim");
  const target = trimIndex >= 0 ? argv[trimIndex + 1] : "";
  if (!target) {
    throw new Error("Usage: bun spec/plugins/video-mode.ts trim <video.webm|directory>");
  }

  const videos = await findVideos(target);
  if (!videos.length) {
    throw new Error(`No .webm videos found at ${target}`);
  }

  for (const video of videos) {
    const result = await trimLeadingWhiteFrames(video);
    const relative = path.relative(process.cwd(), result.path) || result.path;
    if (result.trimmed) {
      console.log(`trimmed ${relative} from ${result.trimStart.toFixed(3)}s`);
    } else {
      console.log(`kept ${relative}: ${result.reason}`);
    }
  }
}

/**
 * Highlights elements before actions and pauses for video recording.
 * Also pauses after tests complete for better video endings.
 */
export const videoMode = (options: VideoModeOptions = {}): Plugin => {
  const pauseBefore = options.pauseBefore ?? 1000;
  const pauseAfterTest = options.pauseAfterTest ?? 3000;
  const highlightStyle = options.highlightStyle ?? "3px solid gold";
  const skipMethods = options.skipMethods ?? ["waitFor"];

  return {
    name: "video-mode",

    middleware: async ({ locator, method }, next) => {
      if (skipMethods.includes(method)) return next();

      // Skip if called from test-helpers (internal navigation etc)
      const stack = new Error().stack || "";
      if (stack.includes("test-helpers.ts")) return next();

      using _ = await setupHighlight(locator, highlightStyle, pauseBefore);
      return await next();
    },

    testLifecycle: (emitter) => {
      return emitter.on("afterTest", async ({ testInfo }) => {
        await new Promise((resolve) => setTimeout(resolve, pauseAfterTest));
        console.log(`video will be written to ${testInfo.outputDir}/video.webm`);
        console.log(`trim leading blank frames with: bun spec/plugins/video-mode.ts trim ${testInfo.outputDir}/video.webm`);
      });
    },
  };
};

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
