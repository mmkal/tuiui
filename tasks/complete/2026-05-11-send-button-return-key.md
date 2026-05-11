---
status: complete
size: small
---

# Send Button Return Key

Status: Done and moved to complete on 2026-05-11. The composer submit control now looks like a return key while keeping the accessible button name and submit behavior.

- [x] Replace or restyle the "Send" affordance so it feels like a return key. _`client/app.ts` renders an aria-hidden `↵` glyph inside the submit button._
- [x] Preserve the current submit behavior and accessibility label. _The button keeps `aria-label="Send"` and still calls `sendComposer`._
- [x] Verify the control still fits cleanly in the composer on mobile and desktop. _CSS makes the button square and the mobile Playwright spec asserts the visible glyph._

## Implementation Notes

- The accessible name should remain clear for tests and screen readers.
- The visible affordance can be an enter/return glyph rather than the word "Send".
- Preserve the existing click and Enter-key submit behavior.
