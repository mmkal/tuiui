---
status: complete
size: small
---

# Mobile Toast Placement

Status: Done and moved to complete on 2026-05-11. Mobile toasts now render below the app bar with side insets so they stay near the top without covering the hamburger menu.

- [x] Audit current toast positioning across mobile and desktop. _Desktop remains bottom-right; only the mobile media query in `client/styles.css` changes._
- [x] On mobile, render toasts at the top with side spacing. _The mobile `.toast-viewport` now uses top placement below the app bar and 10px left/right insets._
- [x] Verify the hamburger menu remains tappable and visually unobscured while a toast is visible. _`spec/tuiui.spec.ts` checks the page-load toast does not intersect the menu button._

## Implementation Notes

- Keep desktop toast placement unchanged unless the CSS needs a shared variable.
- On mobile, prefer top safe-area placement with left/right inset so the toast does not cover the session hamburger or screen edge.
- Add/adjust Playwright coverage in the existing mobile chrome spec if possible.
