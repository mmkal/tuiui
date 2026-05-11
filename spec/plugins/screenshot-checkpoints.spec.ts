import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test as base } from "@playwright/test";
import { addPlugins } from "../playwright-plugin.ts";
import { screenshotCheckpoints } from "./screenshot-checkpoints.ts";

const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await using pluginPage = await addPlugins({
      page,
      testInfo,
      plugins: [
        screenshotCheckpoints({
          selectors: ["#checkpoint"],
          methods: ["waitFor"],
        }),
      ],
    });

    await use(pluginPage);
  },
});

test("captures matched locator screenshots inside the test output directory", async ({ page }, testInfo) => {
  await page.setContent(`
    <main>
      <h1>Screenshot checkpoints</h1>
      <section id="checkpoint">ready for capture</section>
    </main>
  `);

  await page.locator("#checkpoint").waitFor();

  const screenshotDir = path.join(testInfo.outputDir, "screenshots");
  const files = fs.readdirSync(screenshotDir).filter((file) => file.endsWith(".png"));
  expect(files).toHaveLength(1);
  expect(files[0]).toContain("after-waitFor");
});
