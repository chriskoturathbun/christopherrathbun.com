# Dreamlist — a shared dream list for two

**Route:** `christopherrathbun.com/dreamlist`
**Date:** 2026-09-20
**First users:** Chris and his girlfriend.

## What it is

A joint list of things two people want to do together. Not a task manager — a
dream list. "Ramen in Tokyo." "That hike with the waterfall." "Finally see the
Rothkos." Some have a place. Some have a date. All of them have two people
attached.

The list is the product. Map and calendar are views of the same dreams, not
separate features with separate data.

## Design principles

1. **The items are the interface.** No cards inside panels inside frames. A
   dream is a line of text with room to breathe. Chrome appears only on hover
   or focus, and leaves when it's done.
2. **Adding is one gesture.** A single input sits at the top of the list.
   Type, press enter, the dream exists. Place, date, and notes are added
   *after* — never as a form standing between an idea and the list.
3. **Progressive disclosure.** A collapsed item shows title, a place chip, a
   date chip, and a note count. Expanded, it shows everything. Nothing is
   hidden behind a menu that could be shown inline.
4. **Motion is physical.** Items settle rather than snap. Dragging follows the
   finger. Completing has weight to it.
5. **Warm, not clinical.** Paper-white surfaces, soft shadow instead of
   borders, one warm accent. This is a list about a relationship.

## Architecture

Extends the existing worker. No new infrastructure.

```
src/dreamlist.js          worker module — API + page serving, exports handleDreamlist
public/dreamlist/index.html   the SPA (Clerk sign-in, three views)
public/dreamlist/dreamlist.css
test/dreamlist.test.mjs   node sanity tests for pure helpers
```

Routing: `worker.js` delegates `/dreamlist`, `/dreamlist/*`, and `/d/<token>`
(the short invite link) to `handleDreamlist`. `wrangler.toml` adds those paths
to `run_worker_first`.

Data lives in the existing `DB` D1 binding, with tables created on demand by
`ensureSchema()` — the same pattern parties/reminders use. Email goes out
through `sendResendEmail`. Auth is the existing Clerk instance via
`verifyClerkJWT`.

### Schema

```sql
dream_lists       id, owner_clerk_id, name, emoji, accent, created_at, updated_at
dream_members     id, list_id, clerk_id, email, name, role(owner|member),
                  status(pending|active), invite_token, invited_at, joined_at
dream_items       id, list_id, title, notes, status(open|done), position REAL,
                  starred INTEGER, category,
                  place_label, place_address, lat REAL, lng REAL,
                  scheduled_at TEXT, all_day INTEGER,
                  created_by_clerk_id, created_by_name,
                  done_at, done_by_clerk_id, done_by_name,
                  created_at, updated_at
dream_notes       id, item_id, list_id, author_clerk_id, author_name, body, created_at
dream_geocache    query TEXT PRIMARY KEY, label, address, lat, lng, cached_at
```

`position` is a float so reordering writes one row: an item dropped between
two neighbours takes the midpoint of their positions. `dream_geocache` keeps
Nominatim lookups off the wire on repeat searches.

### Membership

A list has one owner and any number of members. Members are equal — either
can add, edit, complete, reorder, or annotate any item. Authorship is
recorded and displayed (who dreamed it, who completed it) but confers no
special rights. This is deliberate: a shared list where one person's items
are second-class isn't shared.

`requireMember(request, env, listId)` resolves the Clerk JWT, then matches
either `owner_clerk_id` or an active row in `dream_members` on `clerk_id`.
On first authenticated request a pending invite whose email matches the
signed-in user's Clerk email is upgraded to active and bound to their
`clerk_id` — so clicking the invite link and signing up is the whole flow.

A default list is created on a user's first visit, so they land on a
working list rather than an empty-state decision.

### Views

All three read the same `GET /dreamlist/api/lists/:id` payload. Switching
views never refetches.

**List** — the default and the hero. Dreams in `position` order, starred ones
floating to a "Right now" section at the top. Completed dreams collapse into a
"Done together" section with a count, expandable, showing who completed each
and when.

**Map** — Leaflet with OpenStreetMap tiles. One pin per dream that has
coordinates; clicking a pin opens that dream. Auto-fits bounds to the pins.
Dreams without a location are listed beneath the map as "not on the map yet"
so they aren't silently invisible.

**Calendar** — a month grid, dreams on their `scheduled_at` day, with an
agenda list of what's coming next. Clicking a day filters to it; clicking an
empty day starts a dream scheduled for that day.

### Location

Geocoding proxies through the worker: `GET /dreamlist/api/geocode?q=…` checks
`dream_geocache`, then calls Nominatim with a proper User-Agent and caches the
result. The browser never talks to Nominatim directly, which keeps us inside
their usage policy and makes repeat searches instant. Results are shown as a
short pick-list; choosing one attaches `place_label`, `place_address`, `lat`,
`lng` to the item. A place can also be typed freeform with no coordinates —
it just won't appear on the map.

### Invites

Owner types an email → `POST /dreamlist/api/lists/:id/invite` creates a
pending member with an unguessable token and sends a Resend email. The link
is `christopherrathbun.com/d/<token>`. Opening it stores the token and sends
the visitor to Clerk sign-in; after sign-up the token is claimed and they're
in. Tokens are single-list and don't expire — for a two-person list, expiry
is friction with no security benefit, since the token is already unguessable
and grants access only to one list.

Invite email copy is written to read like a person wrote it, per the repo's
email voice rule.

### Sync

Both people have the list open at once, so writes need to show up. Polling:
`GET …/lists/:id?since=<updated_at>` every 8 seconds while the tab is
visible, paused when hidden. The UI is optimistic — a change renders
instantly and reconciles on the next poll. For two users this is
indistinguishable from realtime and costs nothing; a Durable Object would be
the answer at larger scale and is not needed here.

### Error handling

- Every mutation is optimistic with rollback: the UI reverts and shows an
  inline message if the request fails. No modal error dialogs.
- Geocoding failure degrades to a freeform place string — you still get your
  dream, just not a pin.
- A write that 401s (session expired) re-opens Clerk sign-in and retries.
- Nominatim rate-limit or outage returns an empty result set with a "couldn't
  search places right now" note, never a crash.

### Testing

`test/dreamlist.test.mjs` covers the pure helpers in the same plain-node style
as `test/parties.test.mjs`: position midpoint calculation (including the
degenerate equal-neighbour case), invite email builder, date formatting and
grouping for the calendar, item sanitization, geocode result normalization,
and the "which dreams have coordinates" partition used by the map. Run with
`node test/dreamlist.test.mjs`.

## Phases

1. **Foundation** — schema, auth, membership, list + item CRUD, the list view,
   add/complete/delete/reorder/star. The app is useful at the end of this.
2. **Places** — geocode proxy with cache, place picker on an item, map view.
3. **Time and words** — `scheduled_at`, calendar view, notes threads.
4. **Sharing** — invite email, token claim flow, member display, authorship.
5. **Polish** — motion, empty states, mobile, sync loop, tests, deploy.

## Out of scope

Multiple lists per user beyond the default one, photo attachments, public
sharing, push notifications, native apps, checklists within items, recurring
items. All are plausible later; none are needed for two people to start
dreaming in public.
