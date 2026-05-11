import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin, ActionContext, OverrideableMethod } from "../playwright-plugin.ts";

export type ScreenshotCheckpointMatcher = string | RegExp | ((ctx: ActionContext) => boolean);

export type ScreenshotCheckpointOptions = {
  /**
   * Locator string matchers. Examples:
   * - ".terminal-host"
   * - "getByTestId('rendered-terminal')"
   * - /getByRole\('button'.*Launch/
   */
  selectors: ScreenshotCheckpointMatcher[];
  /** Capture before the matched action too. Default: false */
  before?: boolean;
  /** Capture after the matched action. Default: true */
  after?: boolean;
  /** Capture after a matched action fails. Default: true */
  onFailure?: boolean;
  /** Restrict capture to these patched Locator methods. Default: all patched methods */
  methods?: OverrideableMethod[];
  /** Subfolder under Playwright's per-test outputDir. Default: "screenshots" */
  folderName?: string;
  /** Screenshot timeout in milliseconds. Default: 1000 */
  timeout?: number;
};

export const screenshotCheckpoints = (options: ScreenshotCheckpointOptions): Plugin => {
  const after = options.after !== false;
  const onFailure = options.onFailure !== false;
  const folderName = options.folderName || "screenshots";
  let index = 0;

  return {
    name: "screenshot-checkpoints",
    middleware: async (ctx, next) => {
      if (!matches(ctx, options)) {
        return await next();
      }

      if (options.before) {
        await capture(ctx, folderName, index++, "before", options.timeout || 1000);
      }

      try {
        const result = await next();
        if (after) {
          await capture(ctx, folderName, index++, "after", options.timeout || 1000);
        }
        return result;
      } catch (error) {
        if (onFailure) {
          await capture(ctx, folderName, index++, "failure", options.timeout || 1000);
        }
        throw error;
      }
    },
  };
};

function matches(ctx: ActionContext, options: ScreenshotCheckpointOptions) {
  if (options.methods && !options.methods.includes(ctx.method)) {
    return false;
  }
  if (options.selectors.length === 0) {
    return false;
  }

  const locatorString = ctx.locator.toString();
  return options.selectors.some((selector) => {
    if (typeof selector === "string") {
      return locatorString.includes(selector);
    }
    if (selector instanceof RegExp) {
      return selector.test(locatorString);
    }
    return selector(ctx);
  });
}

async function capture(
  ctx: ActionContext,
  folderName: string,
  index: number,
  phase: "before" | "after" | "failure",
  timeout: number,
) {
  const directory = path.join(ctx.testInfo.outputDir, folderName);
  fs.mkdirSync(directory, { recursive: true });

  const filename = [
    String(index + 1).padStart(3, "0"),
    phase,
    ctx.method,
    sanitizeLocator(ctx.locator.toString()),
  ].join("-") + ".png";
  const filepath = path.join(directory, filename);

  try {
    await ctx.locator.screenshot({ path: filepath, timeout });
  } catch {
    try {
      await ctx.page.screenshot({ path: filepath, fullPage: true, timeout });
    } catch {
      return;
    }
  }

  await ctx.testInfo.attach(`screenshot checkpoint ${index + 1}: ${phase} ${ctx.method}`, {
    path: filepath,
    contentType: "image/png",
  });
}

function sanitizeLocator(locatorString: string) {
  const compact = locatorString
    .replace(/^locator@?/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return compact || "locator";
}
