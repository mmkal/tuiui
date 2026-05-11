If I tell you to capture a photo, run `bun upload.ts capture`. It will print out a URL which you should show me. I'll click the URL and upload a photo. The CLI will wait until the photo exists, then print out its path and exit.

## Pull request media

When a pull request would benefit from visual review, include screenshots or short videos in the PR body. The most reliable way to upload arbitrary media to GitHub is to use the browser attachment flow:

1. Open the pull request in GitHub with Playwriter.
2. Edit the PR body or a comment.
3. Click the editor's `Attach files` button, choose the local image/video, and wait for GitHub to insert a `https://github.com/user-attachments/assets/...` URL.
4. Put the raw attachment URL on its own paragraph, not inside Markdown link syntax. Use `https://github.com/user-attachments/assets/...`, not `[video.webm](https://github.com/user-attachments/assets/...)`.
5. Save the edit. GitHub will render supported videos inline as a player.

The GitHub CLI can edit the PR body once you already have an attachment URL, but it does not provide an equivalent generic upload command for markdown attachments.

## Playwright plugins

This repo vendors the Playwright plugin system from `../iterate/spec/plugins` and `../iterate/spec/playwright-plugin.ts`. Keep the copied core close to Iterate's version so updates can be applied mechanically.

The plugin system wraps public `Locator` methods such as `click`, `fill`, `press`, `hover`, and `waitFor`. It does not reliably hook arbitrary `expect(locator).toBeVisible()` style assertions, because Playwright does not expose a clean plugin point for those matcher internals. When you need plugin behavior at a precise point, use a plugin-able locator call like `await page.locator(...).waitFor()` or a normal locator action.

Use `PLAYWRIGHT_SCREENSHOT_SELECTORS` to capture screenshots at specific plugin-able checkpoints during a spec run. It accepts comma-separated substrings matched against Playwright locator strings, for example:

```sh
PLAYWRIGHT_SCREENSHOT_SELECTORS=".terminal-host,getByTestId('session-brief')" bun run spec --grep "my test name"
```

Matching checkpoints are written under the current test's Playwright `test-results/.../screenshots/` directory and attached to the Playwright report. For test-specific behavior, import `screenshotCheckpoints` from `spec/plugins` and add it through `addPlugins`.

Use `VIDEO_MODE=1 bun run spec --grep "my test name"` to enable the copied video-mode plugin, which highlights locator actions and pauses around them so Playwright videos are easier to review. Before uploading Playwright videos to a PR, run `bun spec/plugins/video-mode.ts trim <video.webm|test-results-directory>` so leading blank frames are removed and GitHub's inline preview starts on the first real app frame.
