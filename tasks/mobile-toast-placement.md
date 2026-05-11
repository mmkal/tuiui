---
status: in-progress
size: small
---

# Mobile Toast Placement

Status: Spec commit for bundled UI polish branch. This task will be implemented with the return-key send button and SDK summary task cleanup because all three are tiny UI/task-file maintenance changes.

- [ ] Audit current toast positioning across mobile and desktop.
- [ ] On mobile, render toasts at the top with side spacing.
- [ ] Verify the hamburger menu remains tappable and visually unobscured while a toast is visible.

## Implementation Notes

- Keep desktop toast placement unchanged unless the CSS needs a shared variable.
- On mobile, prefer top safe-area placement with left/right inset so the toast does not cover the session hamburger or screen edge.
- Add/adjust Playwright coverage in the existing mobile chrome spec if possible.
