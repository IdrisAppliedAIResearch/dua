# Dua — Interaction Workflow

The complete state machine of a session. Nothing outside this document is user-visible.

## States

### CLOSED (resting state)
- Book lies on the desk, front cover up, centered. No UI. No page numbers, no buttons.
- Enter state: click cover · `Enter` · `Space`. Cover leaf turns once; book shifts to
  the open footprint (centered spread) and reveals the first spread.

### VIEW (default reading state)
- Left = verso, right = recto, gutter shadow, faint folios at outer bottom corners.
- Navigation (invisible 50/50 screen zones — tap the left half of the screen
  to turn back, the right half to turn forward; works identically on phones):
  - `→` `Space` `PgDn` next · `←` `PgUp` previous · `End` last page · `Home`/`Esc` close the book
- Hover affordances (only on mouse devices, while hovering the relevant object):
  - outer page corner lifts slightly = the turn direction hint
  - an entry gains a faint pencil glyph in the outer margin
- On touch devices the pencil is always faintly visible and finger-sized; it is
  the way to edit on a phone (double-click-to-edit is mouse-only, so rapid
  page-turning taps never open the editor by accident).
- The blank final page carries a faint embossed seal with a **+**: click → NEW-ENTRY edit.
- Double-click an entry's text → EDIT that entry (mouse only).
- `e` edits the first entry visible on the current spread; `n` = new entry.
- `i` or the small-caps **Index** tab at the top opens the INDEX OVERLAY: one
  scrollable page (not a leaf) listing each entry's short name and page number;
  a row click travels to that entry; a fixed bar at the bottom (always visible,
  not at the end of the list) holds a page-number field + **Go to page** for
  fast travel, ✕ to close, and a **+** button that opens a draft at the very
  end of the book.

### EDIT (exactly one entry at a time)
- The book does NOT jump: editing starts on the page the author is standing
  on, and the caret lands at the end of that page's last paragraph. A
  multi-page entry is edited page by page, wherever the author is.
  (Double-click first turns the page, so the pair's pre-click spread is
  restored before the editor opens.) That entry becomes editable in place
  (same typography, paper darkens a hair to signal it).
- Icon rail fades in, bottom-outer corner of the edited page (top-outer corner
  and larger on touch devices, where the keyboard covers the page bottom) —
  icons only, on every page the edited entry occupies:
  - ✓ **save** — POST (new) or PUT (existing); relayout; stay where the author
    stands; return to VIEW
  - ✕ **cancel** — revert to last saved snapshot; return to VIEW
  - 🗑 **delete** — click arms the icon (it inverts); click again commits DELETE,
    leaf turns back; a stray click anywhere or `Esc` disarms first
- Typing: plain text; blank line = new paragraph; a dated entry's date line is also editable
  (click on it) so a late entry can be backdated; undated entries show no date line.
- `Ctrl/Cmd+S` save · `Esc` cancel · while editing, a tap on the screen's
  left/right halves turns the page (the caret follows to the edited entry's
  page on screen; the book never closes out from under an edit) — so an entry
  can be continued across pages without leaving edit. `Ctrl+←/→` turns too.
- Growing text re-paginates LIVE while editing: after a short typing pause,
  anything that spills past a page's bottom moves onto the entry's next page
  (new pages are created when the entry runs out), and the book flips to keep
  the writing on screen. No save cycle is needed just to keep writing; the
  words themselves are never altered, only placed.

### Transitions
```
CLOSED ↔ VIEW; VIEW → EDIT(x) → VIEW; VIEW → EDIT(new draft) → VIEW (first save persists)
```
There is no other mode, panel, dialog, toast or modal. Confirmations are
icon-state changes, never popups.

## Failure behavior
- Server down: dry ink blot at the book's fore-edge; saves queue in memory and retry
  on next save attempt; no error dialogs.
- Empty book: first content page shows a faint embossed seal inviting a first entry
  (click the seal, or the **+** in the Index bar).

## Visual identity
- Deep emerald leather cover, blind-debossed double rule frame, letter-spaced
  serif title over the Arabic دعاء, gold eight-point star (rub el Hizb) ornament.
- Cream paper with subtle grain; deep pine desk; hairline gold folios and
  rules; deep-green date lines and hovers, garnet only for an armed delete.
- EB Garamond throughout; old-style figures for folios and dates.
- Motion: one easing curve for all turns (cubic-bezier(.4,.05,.2,1), ~750ms);
  affordances fade 150–250ms. Nothing bounces. Timeless, not playful.
