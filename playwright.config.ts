import { defineConfig } from "@playwright/test";

const videoMode = process.env.VIDEO_MODE === "1";

export default defineConfig({
  testDir: "./spec",
  timeout: videoMode ? 120_000 : 35_000,
  expect: { timeout: 12_000 },
  use: {
    trace: "retain-on-failure",
    video: videoMode ? "on" : "retain-on-failure",
  },
});
