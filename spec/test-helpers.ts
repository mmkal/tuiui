import * as path from "node:path";
import { test as base } from "@playwright/test";
import { addPlugins } from "./playwright-plugin.ts";
import {
  llmRecover,
  screenshotCheckpoints,
  uiErrorReporter,
  videoMode,
} from "./plugins/index.ts";

export const test = base.extend({
  page: async ({ page: basePage }, use, testInfo) => {
    await using page = await addPlugins({
      page: basePage,
      testInfo,
      plugins: [
        uiErrorReporter(),
        !!process.env.LLM_RECOVER && llmRecover(),
        screenshotSelectorsFromEnv().length > 0 && screenshotCheckpoints({
          selectors: screenshotSelectorsFromEnv(),
        }),
        !!process.env.VIDEO_MODE && videoMode(),
      ],
      boxedStackPrefixes: (defaults) => [
        ...defaults,
        path.join(import.meta.dirname, "plugins"),
      ],
    });

    await use(page);
  },
});

export { expect } from "@playwright/test";

function screenshotSelectorsFromEnv() {
  return (process.env.PLAYWRIGHT_SCREENSHOT_SELECTORS || "")
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}
