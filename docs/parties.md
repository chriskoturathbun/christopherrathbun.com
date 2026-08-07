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
