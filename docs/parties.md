# Parties — event invitations + RSVPs

A Partiful-style party tool that lives on christopherrathbun.com: create an
event, invite people by text or email, guests RSVP from a link with **no
account, no app, and no questions**. All data stays in the site's own D1
database — nothing is shared with or sold to anyone.

## URLs

| Path | What |
|---|---|
| `/parties` | Host app (Clerk sign-in). Create events, manage guests, send invites/reminders/updates. |
| `/e/<token>` | Guest RSVP page. A personal token (per-guest) or the event's open share token (starts with `s`). Public, no auth. |

## How it works

- **Host side** is Clerk-gated (same Clerk instance as `/reminders/dashboard`;
  JWT verified by `src/reminders-clerk.js`). Any signed-in user can host.
- **Guests** are identified purely by an unguessable token in their link
  (80 bits, hex). Personal links pre-fill their name and current RSVP; the
  event-wide share link lets anyone with it RSVP by leaving a name and an
  optional phone/email for updates.
- **SMS** goes out through the existing Twilio sender
  (`sendTwilioSms` in `src/reminders-alerts.js`, secrets `TWILIO_*` already on
  the worker). **Email** goes through Resend (`RESEND_API_KEY`), from
  `PARTY_EMAIL_FROM` (defaults to `Invites <reminders@mail.giftanagent.com>`
  — the currently verified Resend domain; switch this var once a
  christopherrathbun.com sender is verified in Resend).
- Guests with a phone number get a text; email-only guests get an email.

## Storage

Three tables in the `DB` D1 binding (`christopherrathbun_users`), created on
demand by `ensureSchema` in `src/parties.js` (same pattern as reminders — no
migration files):

- `party_events` — event + host, `share_token` for the open link
- `party_guests` — per-guest personal `token`, `rsvp`
  (pending/yes/maybe/no), plus-ones, note; unique per event on phone and email
- `party_sends` — log of every SMS/email attempt (channel, kind, ok, sid)

## Partiful-parity features

- **Cover themes + images** — 8 color themes (`COVER_THEMES`) restyle the
  whole guest page; an optional `https` cover image URL shows on the page
  and in link previews.
- **Rich link previews** — `/e/<token>` responses get OpenGraph/Twitter meta
  injected server-side (`buildOgMeta`), so the texted link unfurls as a card
  in iMessage/WhatsApp. The preview image is the cover image, else a
  thum.io screenshot of the open-invite page (share token only — personal
  tokens are never sent to the screenshot service).
- **Who's going** — first names + plus-one counts on the guest page
  (host-toggleable, contact info never exposed).
- **The wall** — a comment feed on the guest page. Posting requires a
  personal guest token (open-link guests get one after RSVPing), capped at
  20 comments per guest; hosts moderate from the dashboard.
- **Waitlist** — when a capacity-limited event fills, open-link "yes" RSVPs
  land on the waitlist; the host admits with one tap and the guest gets a
  "you're in!" text automatically.
- **Auto reminder** — the per-minute cron (`runPartyReminders`, wired in
  `src/worker.js`) texts every non-declined guest once, 22-24h before the
  event, in batches of 12/minute. `party_guests.reminded_at` is set before
  sending so a crashed tick can't double-text.
- **Co-hosts** — added by email (`party_cohosts`); anyone signing into
  Clerk with that email can manage the event.

## Abuse limits (in `src/parties.js`)

- 200 guests per event, 25 sends per API call (the host UI batches),
  500 sends per host per rolling day across all their events.
- Invite SMS includes "Reply STOP to opt out"; Twilio enforces STOP
  server-side on the sending number.

## API sketch

Host (Clerk Bearer): `POST/GET /parties/api/events`,
`GET/PATCH /parties/api/events/:id`, `POST .../guests`,
`DELETE .../guests/:gid`, `POST .../send` (`{kind: invite|reminder|update,
guestIds?, message?, dryRun?}`).

Public: `GET /parties/api/link/:token` (resolves either token type),
`POST /parties/api/rsvp/:token`, `POST /parties/api/open/:shareToken`.

## Tests

`node test/parties.test.mjs` — pure helpers (guest-line parsing, E.164
normalization via reminders' `normalizePhone`, SMS/email builders, event-time
formatting).

## Partiful-parity side functions (Aug 2026)

Event fields beyond the basics: `host_nickname` ("Hosted by The Rathbun Crew"),
`cost_text` (free-text cost per person), `dress_code`, `link_url` / `playlist_url` /
`registry_url` (https-validated), `rsvp_deadline` (RSVPs lock server-side after it),
`is_public` (off = the open share link stops accepting RSVPs), and `title_font`
(classic / eclectic / fancy / literary — Google Fonts on both pages).

**Date poll** — when the host can't pick a date: `party_date_options` +
`party_date_votes` tables. Host sets options (create form or
`POST /parties/api/events/:id/date-options`), guests with a personal token vote via
`POST /parties/api/datevote/:token` (checkbox semantics, replaces their votes),
host locks a winner with `POST .../date-options/:id/pick` → sets `starts_at`,
deletes the poll.

**Example covers** — 16 generated SVGs in `public/parties/covers/` (regenerate with
the build script in the repo history; deterministic seeds). Picking one stores its
absolute URL in `cover_image_url`. `ogImageUrl` skips SVG covers for og:image
(unfurlers don't render SVG) and falls back to the screenshot service.

**Full emoji library** — `public/parties/emoji.json` (~1,900 emoji, Unicode 17,
grouped, searchable by name; skin-tone variants collapsed). The host page's
"➕ More" opens the picker modal.
