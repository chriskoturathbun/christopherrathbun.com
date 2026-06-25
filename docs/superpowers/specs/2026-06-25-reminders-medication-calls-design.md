# Reminders — AI Medication-Reminder Calls

**Design spec** · 2026-06-25 · target URL: `christopherrathbun.com/reminders`

## 1. Summary

An AI voice agent calls patients (e.g. grandparents) on a daily schedule and reminds
them, in its own voice, to take their medication ("Hi [name], it's time to take your
X, Y and Z"). It is an alarm clock that calls and talks. If the patient asks a question
or expresses a need on the call, the agent detects it and alerts the purchaser and the
emergency contact by email **and** SMS.

The product has two intake flows — a patient signing up for themselves, and a family
member signing up on behalf of a loved one. Either flow captures phone number, emergency
contact, explicit consent, and the medication schedule. The schedule is automatically
optimized so medicines that can be taken together are grouped into the fewest call times.
A Clerk (Google) login lets purchasers see how many times the agent has called and review
history.

**The #1 non-negotiable requirement: calls always happen on time.**

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Scope | Public-ready, **soft-launch** — full public signup built, but live calls gated behind manual approval initially |
| Payment | **Free in v1**, but usage + per-call cost is tracked so Stripe can be added cleanly later |
| Scheduling | **Bland native `start_time` pre-scheduling + per-minute Cloudflare cron safety-net** (redundant) |
| Alerts | **Both email + SMS** to purchaser and emergency contact |
| Hosting | Inside existing `christopherrathbun-landing` Worker; new module + **dedicated D1 `reminders`** |
| Grouping tolerance | **±45 min** default window for merging medicines into one call |
| Voice | Bland `june` (warm), agent self-identifies as AI |

## 3. Architecture

Built inside the existing `christopherrathbun-landing` Cloudflare Worker:

- **Routing:** add `/reminders*` worker-first routes in `wrangler.toml`, dispatch in
  `src/worker.js` to a new module `src/reminders.js` (mirrors how `/twistedchess`,
  `/users`, `/vighnaatextllm` are wired).
- **Pages:** static HTML/CSS/JS under `public/reminders/` (no build step, matching the
  existing pattern).
- **Data:** a **new dedicated D1 database** `reminders` (separate from the analytics
  `christopherrathbun_users` DB) to isolate health-adjacent data. New binding e.g. `REMINDERS_DB`.
- **Scheduling:** Cloudflare **Cron Triggers** added to the worker.
- **Reused infra:** deploy pipeline, `OPENAI_API_KEY` (already a worker secret).

Rejected alternatives: a standalone Worker/subdomain (doesn't match the requested
`/reminders` path, duplicates infra); reusing giftagent's Railway/Node cron (backend must
be on Cloudflare).

## 4. Pages

All landing/marketing pages cloned as close to <https://fluid.glass/> as possible —
glassmorphism panels, animated fluid background, generous whitespace, large type. A
Higgsfield-generated ambient hero visual (total Higgsfield spend capped at **$5**).

| Path | Auth | Purpose |
| --- | --- | --- |
| `/reminders` | public | Marketing landing, fluid.glass aesthetic, CTA → intake |
| `/reminders/intake` | public | Signup wizard (two flows) |
| `/reminders/privacy` | public | Privacy policy |
| `/reminders/terms` | public | Terms of service |
| `/reminders/dashboard` | Clerk (Google) | Manage patients, view call history + alerts, edit meds/times |

### 4.1 Intake wizard (`/reminders/intake`)

Step 1 forks: **"For myself"** vs **"For a loved one."**

Steps (loved-one flow shown; self-flow omits the relationship/attestation specifics):
1. Who is this for? (self / loved one + relationship)
2. Patient details — name, phone (validated to **E.164**), IANA **timezone**
3. Purchaser details — name, email, phone (the logged-in/Clerk identity when present)
4. Emergency contact — name, phone, email, relationship
5. **Consent** — three checkboxes, each logged with text version + timestamp + IP:
   - TCPA: consent to receive automated AI voice calls at this number
   - Recording: consent that calls are recorded & transcribed (by Bland)
   - (loved-one flow only) Attestation: "I confirm I have this person's permission"
6. Medicines — for each: name, dose, frequency (once/twice/3×/every-N-hours/custom),
   timing constraints (morning / with food / empty stomach / bedtime / specific time)
7. **Schedule preview** — the optimizer's proposed call times with which meds per call,
   editable before confirming
8. Confirm → account created, patient + plan persisted (status `pending` until approved)

## 5. Data model (D1 `reminders`)

Self-initializing schema (`ensureSchema()` pattern, like `users-dashboard.js`). All
timestamps stored **UTC**; per-patient IANA timezone drives local-time computation.

- `accounts` — `id`, `clerk_user_id`, `email`, `name`, `approved` (0/1 soft-launch gate),
  `created_at`
- `patients` — `id`, `account_id`, `name`, `phone_e164`, `timezone`, `relationship`,
  `is_self`, `status` (pending/active/paused), `created_at`
- `emergency_contacts` — `id`, `patient_id`, `name`, `phone_e164`, `email`, `relationship`
- `medicines` — `id`, `patient_id`, `name`, `dose`, `frequency`, `timing_constraint`,
  `preferred_times` (JSON), `active`
- `call_plan` — `id`, `patient_id`, `local_time` (HH:MM), `medicine_ids` (JSON), `active`
  — the optimizer output: distinct daily call times each naming its meds
- `calls` — `id`, `patient_id`, `call_plan_id`, `scheduled_at_utc`, `bland_call_id`,
  `status` (prescheduled/placed/completed/no_answer/failed), `placed_at`, `duration_sec`,
  `transcript`, `recording_url`, `cost_usd`, `created_at`
- `alerts` — `id`, `call_id`, `patient_id`, `kind` (concern/no_answer/refusal/…),
  `severity`, `summary`, `channels_sent` (JSON), `created_at`
- `consent_log` — `id`, `patient_id`, `type` (tcpa/recording/attestation), `text_version`,
  `ip`, `user_agent`, `created_at`

## 6. Medicine grouping optimizer

**Input:** a patient's medicines, each with a frequency and a timing constraint.
**Output:** the fewest distinct daily call times (`call_plan` rows), each naming the meds
to mention.

Algorithm (simple + explainable for v1):
1. Expand each medicine into its required dose times for the day (from frequency +
   constraint → candidate preferred times, e.g. "with food" → 08:00/12:30/18:00 buckets;
   "bedtime" → 21:00; "every 8h" → 08:00/16:00/00:00).
2. Cluster candidate times that fall within the **±45 min** tolerance window.
3. **Never merge conflicting constraints** (e.g. "empty stomach" must not share a call
   with "with food"); these stay in separate clusters even if times are close.
4. Each cluster → one call time = cluster representative (mean rounded to nearest 15 min).
5. Emit `call_plan` rows; surface as the editable preview in intake step 7.

Constraints respected: min spacing between repeated doses of the same medicine;
constraint conflicts; user edits in the preview override the computed plan.

## 7. Reliability — scheduling (the core requirement)

Redundant, two-layer design:

**Layer 1 — Bland pre-scheduler (hourly cron).** For each `active` patient, compute the
next 24–48h of concrete call datetimes (UTC, from `call_plan` × patient timezone, DST-safe)
and register each with Bland via `start_time`, storing the returned `bland_call_id` and
marking the `calls` row `prescheduled`. Bland's own queue fires them.

**Layer 2 — per-minute safety-net (1-min cron).** Query `calls` for rows due in the
current minute (± small window) that are **not** confirmed placed by Bland, and place them
immediately via the Bland API. This is the backstop guaranteeing an on-time call even if a
pre-scheduled Bland call or a cron tick is missed. Idempotent (a placed/ confirmed call is
never double-placed).

> Implementation note: verify Bland `start_time` support on the account during build. If
> unavailable, Layer 2 alone is robust and becomes primary; Layer 1 is an enhancement.

Only patients whose `account.approved = 1` are scheduled (soft-launch gate).

## 8. The call

Bland `placeCall` with voice `june`, `record: true`, `max_duration` ~180s. Task/script:

> "Hi [name], this is your medication reminder, calling on behalf of [purchaser/family].
> I'm an AI assistant. It's time to take your [med A] and [med B] — [dose notes]. …
> Is there anything you need help with?"

Bland records and transcribes; transcript returned via webhook.

## 9. Need detection → alerts

1. Bland **post-call webhook** → `/reminders/api/bland-webhook` (verified via webhook
   secret). Receives status, duration, transcript, recording URL.
2. Transcript classified by `gpt-4o-mini`: did the patient express confusion, a question,
   a health concern, refusal to take meds, or **not answer**? With a severity.
3. On any detected concern **or** a no-answer/failed call: send **email** (full transcript
   + detected issue + recording link) and **SMS** nudge to **both** the purchaser and the
   emergency contact. Email via SendGrid (or Cloudflare Email Routing); SMS via Twilio
   (`TWILIO_*` already configured in giftagent). Record in `alerts` with `channels_sent`.
4. Always update the `calls` row (status, duration, transcript, cost).

## 10. Auth & soft-launch

- **Clerk (Google)** for the dashboard. Worker verifies the Clerk session/JWT and maps the
  Clerk user → `accounts` row.
- Signup is open, but `accounts.approved` gates whether live calls schedule. Until
  approved, the dashboard shows "pending approval" and no calls are placed.
- Owner-gated approval endpoint (reuse the existing passcode/Google-owner-email pattern
  from `users-dashboard.js`) to flip `approved`.

## 11. Compliance

- Explicit TCPA consent, recording consent, and (loved-one flow) a permission attestation,
  each captured with text version + timestamp + IP in `consent_log`.
- Privacy policy + terms drafted for an AI-voice reminder service: AI-placed calls,
  Bland recording/transcription, OpenAI transcript analysis, data retention, **"not medical
  advice / not a substitute for emergency services or professional medical care."**
- Emergency numbers blocked from being used as a target (reuse giftagent's block list idea).

## 12. Secrets

Pulled from giftagent Doppler where they already exist:
`BLAND_API_KEY`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, a SendGrid API key (or Cloudflare Email
Routing), `OPENAI_API_KEY` (already present), `REMINDERS_CRON_SECRET`,
`BLAND_WEBHOOK_SECRET`, `REMINDERS_ADMIN_PASSCODE`.

## 13. Build phases

1. **Foundation** — D1 schema + landing page (fluid.glass) + intake wizard (both flows) +
   consent + privacy/terms. No calls yet.
2. **Scheduling core** — grouping optimizer + Bland integration + two-layer crons →
   live, on-time calls. (The heart of the product.)
3. **Auth + dashboard** — Clerk Google login + call history / manage meds & times.
4. **Alerts** — Bland webhook → gpt-4o-mini concern detection → email + SMS.
5. **Polish** — Higgsfield ambient visuals (≤ $5), soft-launch approval flow,
   billing-ready usage accounting.

## 14. Out of scope (v1 / YAGNI)

- Stripe billing (structure for it; don't build it)
- Native mobile app
- Two-way SMS conversations with the patient
- Multi-language calls
- Pharmacy / EHR integrations
