---
status: in-progress
size: small
---

# Send Button Return Key

Status: Spec commit for bundled UI polish branch. This will be implemented with mobile toast placement because both touch the compact session chrome and mobile composer surface.

- [ ] Replace or restyle the "Send" affordance so it feels like a return key.
- [ ] Preserve the current submit behavior and accessibility label.
- [ ] Verify the control still fits cleanly in the composer on mobile and desktop.

## Implementation Notes

- The accessible name should remain clear for tests and screen readers.
- The visible affordance can be an enter/return glyph rather than the word "Send".
- Preserve the existing click and Enter-key submit behavior.
