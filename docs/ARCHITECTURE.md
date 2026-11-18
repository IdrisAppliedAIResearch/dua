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
    app.py              FastAPI factory: REST API + /media route + static mount
    store.py            sqlite repository (schema, CRUD, export, picture bytes)
    media_add.py        CLI: put picture files into a running app over HTTP
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
  data/                 dua.db — tracked, and it IS the book: one file holding the
                        entries and, in a media table, their pictures
  tests/test_api.py     CRUD workflow tests (pytest)
  tests/test_media.py   picture storage + media-line round-trip tests (pytest)
  qa/shot.mjs           headless-Chrome screenshot tool (raw CDP)
  qa/workflow.mjs       scripted end-to-end user-workflow test (raw CDP)
  docs/ARCHITECTURE.md  this file
  docs/WORKFLOW.md      mode/interaction state machine, keyboard map
```

## Data model

Two tables in one file: the words as text, the pictures as bytes. The book of dua is
a list of entries. Entries may be undated (e.g. the imported
dua, which the author kept without dates); undated entries appear first, in
insertion order, and show no date line on the page.

```sql
entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,                     -- dua date YYYY-MM-DD, or NULL for undated
  title TEXT NOT NULL DEFAULT '',-- what the page itself shows
  name TEXT NOT NULL DEFAULT '', -- short index label (index only, never displayed on the page)
  body TEXT NOT NULL,            -- plain text; paragraphs separated by \n\n
  created_at TEXT NOT NULL,      -- ISO-8601 UTC
  updated_at TEXT NOT NULL       -- ISO-8601 UTC
)

media(
  name TEXT PRIMARY KEY,         -- what a body line names: "01-IMG_1578.jpg". A key,
                                 -- never a path — there is no directory to traverse
  mime TEXT NOT NULL,            -- from the name's extension, never sniffed from bytes
  bytes BLOB NOT NULL,           -- the picture itself, in this file, beside the words
  sha256 TEXT NOT NULL,          -- the ETag for /media/<name>
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

No rich text, no markdown: plain text is the most durable format. Paragraphs = blank
lines. The client renders them typographically; the server never interprets them.

**The one extension: an embedded picture is a paragraph that names a picture.** A body
paragraph whose entire text matches `media/<name>.<jpg|jpeg|png|webp|gif>` (letter or
digit first, no leading path, no spaces around it) is stored as that exact line and
rendered as the picture instead of as words. Nothing else about the format changes:

- The API and the export still carry plain text. The line *is* the reference, so a
  backup of the SQLite file or an `/api/export` JSON still says which picture belongs
  where — even if the picture itself is gone.
- The bytes live in a `media` table **in the same database file** as the entries:
  `name` (primary key, and the only thing a body line names), `mime`, `bytes`,
  `sha256`, `created_at`, `updated_at`. There is no picture folder to keep in step
  with the book, so the `.db` file *is* the whole book — what gets shipped to the Pi,
  what a backup restores, what an export of the words does not have to carry.
  `python -m dua.media_add FILE…` puts pictures in over HTTP, so the app stays the
  only writer of its own database. The words in a picture stay inside the picture:
  there is no alt text, because a caption field would be a second place the author's
  words could drift.
- `/media/<name>` is a route, not a static mount: it looks the name up and answers
  with the stored bytes, the stored mime, an `ETag` of the `sha256` and
  `Cache-Control: no-cache` (honouring `If-None-Match`). A name is a table key and
  never a path, so there is no directory to traverse; an unknown name is a plain 404
  and the client turns that back into the line it came from.
- Type comes from the name, never sniffed from the bytes, and only what a browser can
  decode is accepted: `.jpg .jpeg .png .webp .gif`. An iPhone `.heic` must be
  re-encoded first; the layout then scales whatever arrives.
- The server never rewrites or validates these lines — it has no idea they are
  special. Only `layout.js` recognizes them (`MEDIA_RE`). Anything that merely *looks*
  like a marker — `media/x.jpg extra words`, `Media/x.jpg`, a nested path — stays an
  ordinary line of text.

**Committing the database file.** The store runs in WAL mode, so the newest bytes —
after `media_add`, sometimes every picture in the book — can be sitting in
`dua.db-wal` while `dua.db` itself is still the old, smaller file. SQLite folds them
back on its own once the last connection closes, but `git add data/dua.db` reads the
main file at whatever instant it is asked to. Checkpoint first, then look at the size
before trusting the commit: a book with eleven pictures in it is not 32 KiB.

```
python -c "import sqlite3; print(sqlite3.connect('data/dua.db').execute('pragma wal_checkpoint(TRUNCATE)').fetchone())"
```

### REST surface (`/api`)

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/entries` | all entries ordered by `(undated first,) date, id` |
| POST | `/api/entries` | `{date?, title?, name?, body}` → 201 + created entry |
| GET | `/api/entries/{id}` | 200 or 404 |
| PUT | `/api/entries/{id}` | full update `{date?, title?, name?, body}`; `name` or `date` omitted = keep stored one |
| DELETE | `/api/entries/{id}` | 204 or 404 |
| GET | `/api/export` | versioned JSON snapshot (Content-Disposition download) |
| GET | `/api/media` | every picture's `name, mime, bytes, sha256, created_at, updated_at` — never the bytes |
| POST | `/api/media` | `{name, data_b64}` → 201, or 200 if that name already existed (its bytes are replaced); 422 for a bad name or type |
| GET | `/api/media/{name}` | one picture's metadata, 200 or 404 |
| DELETE | `/api/media/{name}` | 204 or 404; bodies naming it are left exactly as they are |

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

Outside `/api` there is one static mount, `/` (the `web/` shell), plus the
`/media/<name>` route described above. A middleware sets `Cache-Control`:
`no-store` on `/api/` **and on the shell** (`/`, `*.html`), `no-cache` on `/js/`
and `/css/`, and `no-cache` + `ETag` on a picture. That is not tidiness. A cached
`index.html` pins last week's JavaScript, and last week's JavaScript renders a
picture line as a sentence. The shell is `no-store` rather than `no-cache`
because a copy saved before any freshness header existed is governed purely by
browser heuristics — Safari took a six-day-old shell as fresh for hours and asked
the server for nothing in that window, so a header added later could not reach
it. A picture is the one response worth keeping in the browser: it revalidates by
`sha256` and answers 304 instead of arriving again at a hundred kilobytes.

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
A too-long entry splits across pages.

Algorithm per entry: split the body into paragraphs (blank lines), then fill pages.
Each paragraph is filled by the one routine that suits its kind, so nothing is ever
split in a way that mangles it:

| Paragraph | Routine | Split rule |
|---|---|---|
| prose | `fillProse` | binary-search the largest **word** prefix that fits; the remainder carries to the next page |
| contains a newline (a stanza / hard-broken line) | `fillStanza` | **line-atomic**: whole lines only, never mid-line |
| `media/<file>` | `fillImage` | **block-atomic**: a picture never splits; if it does not fit, it moves whole |

Heights are measured, not estimated: `blockHeight()` renders into the offscreen
`#measure` with identical typography and asks for its height. Output is an ordered
array of page descriptors `{ entryId, entry, paras[], header, cont }` consumed by
`book.js`; `header` marks the descriptor that carries the date/title line, and **`cont`
is the seam marker** — one space when a prose section was cut mid-sentence, one newline
when a stanza was cut mid-stanza, empty when this page simply starts a new section.
`cont` is what lets the editor tell "this page starts a new paragraph" apart from "this
page continues the paragraph above", which is a distinction the *stored text* has to
survive.

Re-layout triggers: entry mutations, window resize (debounced), font load, and — for
pictures — the arrival of a real `naturalWidth/naturalHeight` (the aspect-ratio cache
bumps an `aspectEpoch`, debounced re-paginate), because a picture's height is not
knowable before it loads. Layout is memoized per `colW x colH x aspectEpoch` and
validated per entry by `layoutSignature(entry)` (body, date, title).
Folios and pagination are pure functions of the entry list — the server never knows
about pages.

### The body is invariant

The author's words are devotional text: a save must reproduce them byte for byte, and
an edit that only changes one line must not reflow, re-space or re-break anything else.
Two rules keep that true, both guarded by tests:

1. **A page seam is not a paragraph break.** `editor.collect()` reads the faces back
   into body text. Where two faces continue one section (the `cont` marker above), the
   separator is restored from `data-cont` (space or newline), *not* from the blank line
   that visually separates paragraphs — otherwise merely opening and saving a long
   entry would weld or split sections at wherever the last window size happened to cut.
   Guarded by `qa/workflow.mjs` ("opening and saving an entry leaves its text
   byte-identical").
2. **Never use `innerText` to read a page back.** Off-screen faces are `display:none`,
   where `innerText` silently drops every hard line break. `paraText()` walks child
   nodes instead (text, `BR`, block elements) so a stanza on page nine survives the
   same as one on page one.

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
- Pictures in edit mode are stones, not text: the `<img>` block is
  `contenteditable=false` and unmarked, so the caret flows around it. Two gestures
  remove one, both two-step: Backspace/Delete at the edge of the text beside it
  arms it, and a second press removes the marker line — or, when a picture has no
  text beside it (a run of them, one after another, which is how the author keeps
  hers), a click arms it and the next delete key commits. The click is consumed by
  the editor so it cannot also turn the page. Either way only the line leaves the
  body; the picture in the database is never touched — deleting a picture is its own
  deliberate call (`DELETE /api/media/{name}`). That second gesture exists because a
  `contenteditable=false` island produces no `beforeinput` of its own, so the
  delete key for an armed picture is listened for on the document, not the page.
  A `media/…` line whose picture is not in the database renders as its own text, so
  the reference stays visible and editable rather than showing a broken-image glyph.
- Keyboard: `→`/`Space`/`PgDn` next · `←`/`PgUp` prev · `Home` close (to cover,
  from first spread) · `End` last page · `Enter`/`Space` on cover opens · `e` edit
  entry under caret region · `n` new entry.

### Permanence & failure

- If the API is unreachable the book renders from cached in-memory data and shows a
  dry-ink blot in the corner (only then — silence in the happy path).
- Export endpoint guarantees the dua outlive this codebase.
