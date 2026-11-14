# Dua

A book of daily duʿās: deep-emerald cover, turning leaves, cream paper,
gold rules, no toolbars, no labels — the book is the interface.

## First-time setup

Requires Python 3.11+ and (for the QA harness only) Node.js with a headless
Chrome available on `PATH`.

    python -m venv .venv
    .venv\Scripts\activate        # Windows   (Unix: source .venv/bin/activate)
    pip install -r requirements.txt
    python main.py

The app opens your browser at **http://127.0.0.1:8644**. The whole state of
the app is one SQLite file — `data/dua.db` — which ships with this repository.
Point `DUA_DB` at another file to start an empty book.

## INVARIANT — the entries are the author's words

The text in `data/dua.db` is the author's handwritten devotional material,
verbatim. No layer of this application may rewrite, reformat, "improve", or
reflow it — and contributors must not either. Treat the database like source
comments in a holy book: read it freely, change it only through the app.
(The duʿā text and screenshots are personal writings shared for completeness
of the project; the code is what this repository offers for use.)

## Using it

- Click the cover (or Enter) to open the book.
- Read: click a page's outer half, or → / Space / ←.
- Write: open **Index** and press the **+**, click the **+** on the blank
  last page, or press n. The newest entry always sits at the very end of the
  book. **Enter** creates a blank-line gap; **Shift+Enter** breaks the line
  without one; Backspace at a line's start joins it to the previous one.
- Edit: double-click an entry, or hover and click the margin pencil. Editing
  stays on the page you opened: tap a half of the screen to turn pages while
  editing, and text you type that spills past a page bottom flows onto the
  next page live — keep writing across pages without saving first.
- The icons that appear while editing: ✓ save · ✕ cancel · trash deletes
  (click it twice — first click arms it).
- Close: Esc or Home, or click the desk beside the book.

## Development

    python -m pytest tests -q      # API workflow tests
    node qa/workflow.mjs           # end-to-end browser workflow + screenshots
                                   # (spawns its own local server + temp DB)

Env knobs: `DUA_PORT` (default 8644), `DUA_HOST` (default 127.0.0.1),
`DUA_DB` (default `data/dua.db`).

See `docs/ARCHITECTURE.md` and `docs/WORKFLOW.md` for the design contract:
one-page-at-a-time pagination, phone-first layout, the editing model, and
the verbatim-body rule the store enforces.
