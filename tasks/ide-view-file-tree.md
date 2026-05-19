---
status: ready
size: medium
---

# IDE View File Tree

Status summary: spec is ready and implementation has not started. The goal is a session-page IDE view behind the existing hamburger menu, backed by a cwd file listing and read-only file content rendering.

## Goal

Add a lightweight IDE view to a session page so the user can open the hamburger menu, switch from the terminal/debug views to an IDE view, browse files under the session cwd, and inspect text files in a CodeMirror editor.

## Assumptions

- "Pierre software trees thing" means the file tree should feel like a software IDE tree: nested directories, expandable/collapsible groups, selected-file highlighting, and dense rows optimized for scanning.
- The view should list files under the active session cwd, not arbitrary filesystem roots.
- This first version is read-only. Editing, saving, search, git badges, and binary previews are intentionally out of scope.
- Hidden/system-heavy folders such as `.git`, `node_modules`, and common build output should be omitted from the default tree so the view stays responsive.

## Checklist

- [ ] Add backend endpoints/RPC methods to list a bounded file tree under a session cwd and read text file contents.
- [ ] Add an IDE renderer option to the session hamburger menu.
- [ ] Render a dense file tree with directory disclosure controls and selected file state.
- [ ] Render selected text file contents in read-only CodeMirror.
- [ ] Show useful empty/error states for missing cwd, binary/oversized files, and unavailable files.
- [ ] Cover the workflow with a Playwright spec that launches a session, opens the IDE view, selects a cwd file, and sees its contents.
- [ ] Run focused tests/typecheck and update this task with implementation notes.

## Implementation Notes

- Worktree branch: `ide-view-file-tree`
- Base: `origin/main` because the main checkout had unrelated dirty edits and unpushed local commits.
