# Dua — Architecture

A private book of dua that behaves like a physical book. This document is the foundation;
code must not diverge from it without updating it.

## Design principles

1. **Local-first & durable.** One SQLite file, one JSON export endpoint. No accounts,
   no network dependencies, no build step. The app must still open in ten years with
   `python main.py`.
2. **The book is the interface.** Cover, leaves, gutters, folios, and a blank
   final page carrying a faint seal.
   Every affordance is *diegetic* — part of the book (corners, page seal, margin pencil),
   plus one labeled + button inside the Index bar. Default view mode shows zero UI chrome.
3. **Icons, not words.** Nowhere in the book is a control labeled with text.
   The Index overlay is the one exception: its bottom bar labels **Go to page**
   and ✕ beside the bare **+** (new entry).
4. **Two modes only.** `view` (clean, canonical) and `edit` (temporary, in-place).
   There is no third "management" surface — you edit the book itself.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server | FastAPI + uvicorn (stdlib `sqlite3`, no ORM) | minimal deps, stable API surface |
| Client | Vanilla ES modules, no framework, no bundler | longevity, zero build |
| Typesetting | Self-written pagination engine | flow text into fixed book pages |
| Turn animation | CSS 3D transforms on leaf elements | hardware accelerated, no lib |
| Fonts | Locally vendored EB Garamond woff2 + serif system fallback | offline timelessness |

## Directory layout

```
dua/
  main.py               entry point: starts uvicorn, opens browser
  dua/
    __init__.py
    app.py              FastAPI factory: REST API + static mount
    store.py            sqlite repository (schema, CRUD, export)
  web/
    index.html          single page shell
    css/dua.css design system + book geometry + mode states
    js/main.js          boot: wires modules together
    js/api.js           fetch wrapper (only network code)
    js/state.js         entries store, dirty tracking, mode state machine
    js/layout.js        pagination engine (entries -> pages)
    js/book.js          leaf/spread model + turn animation + navigation
    js/editor.js       edit mode: in-place contenteditable + icon rail
    fonts/              vendored woff2 + fonts.css
  data/                 dua.db (created at runtime; never committed)
  tests/test_api.py     CRUD workflow tests (pytest)
  qa/shot.mjs           headless-Chrome screenshot tool (raw CDP)
  qa/workflow.mjs       scripted end-to-end user-workflow test (raw CDP)
  docs/ARCHITECTURE.md  this file
  docs/WORKFLOW.md      mode/interaction state machine, keyboard map
```

## Data model

One table; the book of dua is a list of entries. Entries may be undated (e.g. the imported
dua, which the author kept without dates); undated entries appear first, in
insertion order, and show no date line on the page.

```sql
entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,                     -- dua date YYYY-MM-DD, or NULL for undated
  title TEXT NOT NULL DEFAULT '',-- what the page itself shows
  name TEXT NOT NULL DEFAULT '', -- short index label (index only, never displayed on the page)
  body TEXT NOT NULL,            -- plain text; paragraphs separated by \n
  created_at TEXT NOT NULL,      -- ISO-8601 UTC
  updated_at TEXT NOT NULL       -- ISO-8601 UTC
)
```

No rich text, no markdown: plain text is the most durable format. Paragraphs = blank
lines. The client renders them typographically; the server never interprets them.

### REST surface (`/api`)

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/entries` | all entries ordered by `(undated first,) date, id` |
| POST | `/api/entries` | `{date?, title?, name?, body}` → 201 + created entry |
| GET | `/api/entries/{id}` | 200 or 404 |
| PUT | `/api/entries/{id}` | full update `{date?, title?, name?, body}`; `name` or `date` omitted = keep stored one |
| DELETE | `/api/entries/{id}` | 204 or 404 |
| GET | `/api/export` | versioned JSON snapshot (Content-Disposition download) |

Validation: `date`, if present, must parse as `YYYY-MM-DD`; on POST a missing/`null`
date makes the entry undated (on PUT, omitting `date` keeps the stored one);
`body` must be non-empty (drafts live
only client-side and never reach the server until saved); `title` optional.
Errors: 422 invalid payload, 404 unknown id. Last-write-wins on conflict (single user).

`store.py` is a plain class with WAL mode and a short busy timeout; `app.py` owns the
connection lifecycle. FastAPI runs the sync endpoints on its threadpool, so every
store operation is serialized behind one reentrant lock (the single shared
connection is never touched concurrently). Unexpected exceptions return an opaque
500 and are logged with traceback on the server. Everything else talks HTTP.

Runtime config is env-only: `DUA_PORT` (8644), `DUA_HOST`
(127.0.0.1), `DUA_DB` (data/dua.db).

## Client model — codex terminology

- **face** — one printed side of paper (a page).
- **leaf** — a physical sheet with a front and back face; the unit that turns.
- **spread** — what the eye sees: two facing leaves' inner faces, or the closed cover.
- **folio** — page number printed in the outer bottom corner.

Face sequence: `F0` front cover → `F1` endpaper/inside cover → `F2..Fn-1` content
pages → `Fn` colophon page → `Fn+1` rear endpaper → back cover (static).
Leaf *j* carries faces `F(2j)` (front) and `F(2j+1)` (back).

`spread s` (s ≥ 1) shows left face `F(2s-1)` and right face `F(2s)`; `spread 0` is
the closed book (only `F0`, centered). Turns animate leaf `s` rotating −180° about
the spine (its left edge); CSS `backface-visibility` swaps front/back automatically.
In single-page mode (< 900px) the container is one page wide and only recto faces
are rendered.

### Layout engine (`layout.js`)

Entries are laid out *chapter-style*: every entry starts at the top of a fresh page.
A too-long entry splits at line boundaries.

Algorithm per entry: render its block (date line, optional title, paragraphs) into
an offscreen measuring clone with identical typography; if it fits one page height,
emit one page; otherwise greedily fill pages, binary-searching the largest word
prefix of the overflowing paragraph that fits the page height. Output: ordered array
of `{ kind, entryId?, blocks[] }` page descriptors consumed by `book.js`.

Re-layout triggers: entry mutations, window resize (debounced), font load.
Folios and pagination are pure functions of the entry list — the server never knows
about pages.

### State machine (`state.js`)

```
CLOSED ──open──▶ VIEW ──⌁ edit entry──▶ EDIT(entryId)
   ▲               ▲  ◀──⌁ save/cancel──┘
   └──close────────┘        EDIT(NEW draft) ◀──Index + / page seal + / `n`
```

Any single mutation, then exactly one of save / cancel, before another. Drafts exist
only in client memory; the first save POSTs.

### Rendering & interaction (`book.js`, `editor.js`)

- DOM built per spread from the full entry list (a book of years stays in the low
  hundreds of faces; no windowing needed). Turn animation rotates whole leaf elements.
- View mode: double-click an entry → EDIT that entry. Hover reveals a faint margin
  pencil beside the entry (click = same as double-click). Hovering the outer page
  corner lifts a subtle curl; clicking the corner (or right/left half, arrow keys)
   turns a leaf. A new entry is opened by the **+** button in the Index
   overlay's bottom bar, or by the faint seal on the blank final page — always at
   the end of the book.
- Edit mode: the entry's faces gain `contenteditable`; a vertical icon rail fades in
  at the page's bottom-outer corner: ✓ save · ✕ cancel · 🗑 delete (delete is
  two-step: first click arms the icon, second click commits; any other action
  disarms). Ctrl/Cmd+S saves. Esc cancels (reverts to last saved snapshot).
- Keyboard: `→`/`Space`/`PgDn` next · `←`/`PgUp` prev · `Home` close (to cover,
  from first spread) · `End` last page · `Enter`/`Space` on cover opens · `e` edit
  entry under caret region · `n` new entry.

### Permanence & failure

- If the API is unreachable the book renders from cached in-memory data and shows a
  dry-ink blot in the corner (only then — silence in the happy path).
- Export endpoint guarantees the dua outlive this codebase.
