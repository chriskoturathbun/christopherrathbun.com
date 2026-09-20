# Dreamlist — a shared dream list for two

A joint list of the things two people want to do together. Not a task
manager: a dream list. Some entries have a place, some have a date, all of
them have two people attached.

The list is the product. Map and calendar are views of the same items, not
separate features with their own data.

## URLs

| Path | What |
|---|---|
| `/dreamlist` | The app. Clerk sign-in; everyone who can see a list can edit it. |
| `/d/<token>` | Invite link. Redirects into the app carrying the token, which is claimed after sign-in. |
| `/dreamlist/api/…` | JSON API, session-gated. |

## How it works

- **Auth** is the existing Clerk instance, JWT verified by
  `src/reminders-clerk.js`. Clerk's default session token carries no name or
  email claim, so `resolveProfile()` fills those from the Backend API and
  caches per user per isolate. Reads never need a profile; only writes that
  record an author do.
- **Membership.** A list has one owner and any number of members. Members are
  equal over items: either can add, edit, complete, reorder, or annotate
  anything. Only the owner renames the list, invites, and removes people.
  Authorship is recorded and shown, but confers no rights — a shared list
  where one person's items are second-class isn't shared.
- **Joining** is one step. `claimPendingInvites()` runs on every
  authenticated request and activates any pending invite whose email matches
  the signed-in user, so clicking the link and signing up is the whole flow.
  `POST /dreamlist/api/claim` covers the case where the person signs up with
  a different address than the one invited.
- **Email** goes through Resend from `DREAMLIST_EMAIL_FROM` (defaults to
  `Dreamlist <reminders@mail.giftanagent.com>`, the verified sender the rest
  of the site already uses).
- **Places.** `GET /dreamlist/api/geocode` proxies Nominatim: it lets us send
  an identifying User-Agent as their policy asks, caches results in
  `dream_geocache` for 90 days so repeat searches are free and instant, and
  keeps the browser from telling a third party what the two of you are
  planning. A lookup failure degrades to a freeform place string — you still
  get the item, just no pin. The map is Leaflet over OpenStreetMap tiles,
  loaded lazily the first time the map view is opened.
- **Ordering.** `position` is a float, so dropping an item between two
  neighbours writes exactly one row (the midpoint). When repeated drops into
  the same gap exhaust float precision, `needsRenumber()` catches it and the
  list is respaced.
- **Sync.** Both people have the tab open, so the client polls every 8
  seconds while visible. The poll pauses while a detail drawer is open or a
  field has focus, because reconciling rebuilds the DOM and would close a
  place dropdown or drop a half-typed note. Mutations are optimistic and roll
  back on failure. Two users at this scale don't need a Durable Object.

## Schema

Created on demand by `ensureSchema()` in the shared `DB` binding, same
pattern as parties and reminders.

`dream_lists` · `dream_members` · `dream_items` · `dream_notes` ·
`dream_geocache`

## Local development

Clerk's production keys are bound to christopherrathbun.com, so sign-in
cannot work against `wrangler dev`. A stand-in covers it:

```bash
npx wrangler dev --port 8791 --var 'DREAMLIST_DEV_USER:user_dev_chris|Chris Rathbun|chris@example.com'
```

The value is `clerkId|name|email`. Pass a different one to act as the other
person and exercise the sharing flow.

This is gated twice. `isLocalDev()` requires the var **and** a request with
no `cf-ray` header; Cloudflare stamps cf-ray on everything crossing its edge,
so a deployed worker can never satisfy the second condition. The var appears
in no config file and no secret, and `test/dreamlist.test.mjs` fails if it is
ever added to `wrangler.toml` or the deploy workflow. `.claude/launch.json`
holds it for local use and is gitignored.

## Tests

```bash
node test/dreamlist.test.mjs
```

Covers the pure helpers — position math including the degenerate cases, date
grouping, the map's pinned/unpinned partition, bounds, geocode normalization,
field sanitization, the invite email — plus the guard that keeps the local
sign-in stand-in out of production.
