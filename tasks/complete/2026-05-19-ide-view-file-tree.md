---
status: complete
size: medium
---

# IDE View File Tree

Status summary: done. The session hamburger menu opens a cwd-scoped IDE route with a Pierre Trees file tree and a read-only CodeMirror file preview; the latest follow-up adds mobile file-tree collapse, 7px editor text, and common CodeMirror language support.

## Goal

Add a lightweight IDE view to a session page so the user can open the hamburger menu, switch from the terminal/debug views to an IDE view, browse files under the session cwd, and inspect text files in a CodeMirror editor.

## Assumptions

- "Pierre software trees thing" means the file tree should feel like a software IDE tree: nested directories, expandable/collapsible groups, selected-file highlighting, and dense rows optimized for scanning.
- The view should list files under the active session cwd, not arbitrary filesystem roots.
- This first version is read-only. Editing, saving, search, git badges, and binary previews are intentionally out of scope.
- Hidden/system-heavy folders such as `.git`, `node_modules`, and common build output should be omitted from the default tree so the view stays responsive.

## Checklist

- [x] Add backend endpoints/RPC methods to list a bounded file tree under a session cwd and read text file contents. _Implemented as `files.fileTree` and `files.fileContent` in `cli.ts`, with session wrappers, cwd containment checks, and file size/binary guards._
- [x] Add an IDE route from the session hamburger menu. _The `IDE` menu button now navigates to `/ide?cwd=...` so refresh keeps the file browser instead of returning to the session view._
- [x] Render a dense file tree with directory disclosure controls and selected file state. _Mounted `@pierre/trees` in the IDE sidebar using compact density, open initial expansion, and path-first selection._
- [x] Render selected text file contents in read-only CodeMirror. _Added the `file-text` editor mode in `client/app.ts` and reused the existing CodeMirror dark theme/read-only plumbing._
- [x] Fix file preview typography. _Added a dedicated file editor theme and tuned the file preview down to compact 7px code text, with an explicit computed-style regression check._
- [x] Add common CodeMirror language highlighting. _The file viewer picks language extensions by file path for TS/JS/JSX/TSX, JSON, YAML, HTML, CSS, Markdown, Python, SQL, XML, and SVG._
- [x] Make the file tree collapsible on mobile. _Added a mobile-only toggle in the file tree header and Playwright coverage for collapse/expand plus a nonzero tree height._
- [x] Show useful empty/error states for missing cwd, binary/oversized files, and unavailable files. _The server returns binary/too-large states and the IDE pane renders messages while leaving the editor read-only._
- [x] Cover the workflow with a Playwright spec that launches a session, opens the IDE view, selects a cwd file, and sees its contents. _Added `opens an IDE view for the session cwd and previews text files` in `spec/tuiui.spec.ts`._
- [x] Run focused tests/typecheck and update this task with implementation notes. _Ran `bun run typecheck`, `bun run spec --grep "opens an IDE view"`, and a manual browser smoke check._

## Implementation Notes

- Worktree branch: `ide-view-file-tree`
- Base: `origin/main` because the main checkout had unrelated dirty edits and unpushed local commits.
- Added dependency: `@pierre/trees@1.0.0-beta.3`.
- Verification needed a local-only `node_modules/fakeagent` wrapper because this origin-main worktree cannot resolve the existing `fakeagent` file dependency; the wrapper is ignored and not part of the branch.
- Manual browser smoke check at `http://127.0.0.1:7391` showed the IDE view rendering repo files and CodeMirror content, with no browser console errors.

## Review Follow-up Notes

- The IDE is now independent of session lifetime once opened: the route carries only the cwd, and the client reads through `clientApi.files`.
- The original `sessions.fileTree`/`sessions.fileContent` RPCs remain as compatibility wrappers over the cwd-based implementation.
- The file preview uses the bundled GitHub dark CodeMirror theme plus language extensions; diagnostic/debug editors still use the existing VS Code dark theme.
