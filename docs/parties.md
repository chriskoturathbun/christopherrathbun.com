# Part Plus One — event invitations + RSVPs

A Partiful-style party tool (internal code name "parties") that lives on
christopherrathbun.com: create an event, invite people by text or email,
guests RSVP from a link with **no account, no app, and no questions**. All
data stays in the site's own D1 database — nothing is shared with or sold
to anyone.

## URLs

| Path | What |
|---|---|
| `/parties` | Host app (Clerk sign-in). Create events, manage guests, send invites/reminders/updates/surveys. |
| `/e/<token>` | Guest RSVP page. A personal token (per-guest) or the event's open share token (starts with `s`). Public, no auth. |
| `/s/<token>` | Guest survey page (survey tokens start with `v`). Public; `?g=<guestToken>` pre-identifies a guest so answers arrive named. |

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
- **Custom surveys** — per-event surveys built on the dashboard (multiple
  choice, checkboxes, or free text; optional required flag). Each survey has
  its own `/s/<token>` link, sendable to the guest list through the same
  batched SMS/email sender (links carry `?g=<guestToken>` so answers arrive
  named; bare links ask for a name). Guests can update their answers; hosts
  see per-option counts and per-person text answers, and can close, reopen,
  or delete a survey. Tables: `party_surveys`, `party_survey_questions`,
  `party_survey_responses` (10 surveys/event, 20 questions, 12 options,
  500 responses, one response per known guest).

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
