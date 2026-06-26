# Reminders — Phase 2 (Scheduling Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn stored medicines into on-time daily reminder phone calls — a medicine-grouping optimizer, DST-safe time computation, a Bland AI calling client, and a redundant Cloudflare cron scheduler that guarantees calls fire on time.

**Architecture:** Two new pure-logic modules (`reminders-schedule.js` = optimizer + timezone math; `reminders-bland.js` = Bland API client), plus additions to `reminders.js` (new D1 tables `call_plan` + `calls`, a `computeAndStoreCallPlan` invoked at intake, and two cron entry points `runPreScheduler`/`runReconciler`). A new `scheduled()` export in `worker.js` dispatches Cloudflare cron triggers. Reliability comes from a **per-minute reconciler that places any due call immediately** (fully within our control); the hourly **pre-scheduler** materializes the next 48h of `calls` rows and best-effort registers them with Bland `start_time` as redundancy.

**Tech Stack:** Cloudflare Workers (Cron Triggers + `scheduled` handler), D1, Bland AI REST API, plain Node `.mjs` tests.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/reminders-schedule.js` | PURE: `optimizeCallPlan`, `clusterEvents`, `expandDoseTimes`, `nextOccurrencesUTC`, `zonedWallTimeToUtc` |
| `src/reminders-bland.js` | Bland API client: `placeCall`, `scheduleCall` (start_time), `getCall` |
| `src/reminders.js` | MODIFY: add `call_plan`/`calls` tables; `computeAndStoreCallPlan`; call it in intake; `runPreScheduler`/`runReconciler`; admin approve endpoint |
| `src/worker.js` | MODIFY: add `scheduled(event, env, ctx)` export dispatching by `event.cron` |
| `wrangler.toml` | MODIFY: add `[triggers] crons` |
| `test/reminders-schedule.test.mjs` | Tests for optimizer + timezone math |

**Reliability note for reviewers:** the per-minute reconciler is the guarantee. Bland `start_time` pre-registration is best-effort redundancy — if it errors or is unsupported on the account, the row stays `scheduled` and the reconciler still places it on time. Never let a Bland pre-registration failure block materialization of a `calls` row.

---

## Task 1: Dose-time expansion + grouping optimizer (TDD)

**Files:** Create `src/reminders-schedule.js`, Create `test/reminders-schedule.test.mjs`

- [ ] **Step 1: Write failing tests** — create `test/reminders-schedule.test.mjs`:

```js
// Run: node test/reminders-schedule.test.mjs
import { expandDoseTimes, clusterEvents, optimizeCallPlan } from '../src/reminders-schedule.js';

let pass = 0, fail = 0;
function ok(c, m){ if(c) pass++; else { fail++; console.error('FAIL:', m); } }
function eq(a, b, m){ ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function deq(a, b, m){ ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// expandDoseTimes: minutes-since-midnight per (frequency,timing)
deq(expandDoseTimes('once_daily','morning'), [480], 'once morning = 08:00');
deq(expandDoseTimes('once_daily','bedtime'), [1260], 'once bedtime = 21:00');
deq(expandDoseTimes('twice_daily','morning'), [480,1200], 'twice = 08:00,20:00');
deq(expandDoseTimes('every_8h','morning'), [480,960,0], 'every_8h = 08:00,16:00,00:00');
deq(expandDoseTimes('every_12h','morning'), [480,1200], 'every_12h = 08:00,20:00');
deq(expandDoseTimes('three_times_daily','noon'), [480,840,1200], '3x = 08:00,14:00,20:00');

// clusterEvents: merge within 45 min, never merge empty_stomach with with_food
// events: {min, cls, idx}
const ev = [
  { min: 480, cls: 'normal', idx: 0 },   // 08:00 med A
  { min: 500, cls: 'normal', idx: 1 },   // 08:20 med B  -> merges with A
  { min: 1260, cls: 'normal', idx: 2 },  // 21:00 med C  -> own cluster
];
const cl = clusterEvents(ev, 45);
eq(cl.length, 2, 'two clusters');
deq(cl[0].idxs, [0,1], 'A+B grouped');
deq(cl[1].idxs, [2], 'C alone');

// conflict: empty_stomach vs with_food never merge even if within window
const ev2 = [
  { min: 480, cls: 'with_food', idx: 0 },
  { min: 490, cls: 'empty_stomach', idx: 1 },
];
const cl2 = clusterEvents(ev2, 45);
eq(cl2.length, 2, 'conflicting constraints stay separate');

// optimizeCallPlan: end-to-end on medicine list
const meds = [
  { name: 'Lisinopril', frequency: 'once_daily', timing: 'morning' },
  { name: 'Vitamin D', frequency: 'once_daily', timing: 'morning' },
  { name: 'Melatonin', frequency: 'once_daily', timing: 'bedtime' },
];
const plan = optimizeCallPlan(meds);
eq(plan.length, 2, 'two call times');
eq(plan[0].local_time, '08:00', 'first call 08:00');
deq(plan[0].medicine_names.sort(), ['Lisinopril','Vitamin D'], 'morning meds grouped');
eq(plan[1].local_time, '21:00', 'bedtime call 21:00');
deq(plan[1].medicine_names, ['Melatonin'], 'melatonin alone');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run → fails** (`node test/reminders-schedule.test.mjs`): module not found.

- [ ] **Step 3: Implement `src/reminders-schedule.js`** (this part — the optimizer):

```js
// Reminders — scheduling: dose-time expansion, grouping optimizer, timezone math. PURE.

const ANCHOR = { morning:480, noon:720, evening:1080, bedtime:1260, with_food:480, empty_stomach:420, specific_time:540 };

// Return dose times (minutes since local midnight) for a medicine's frequency + timing.
export function expandDoseTimes(frequency, timing) {
  switch (frequency) {
    case 'twice_daily':        return [480, 1200];        // 08:00, 20:00
    case 'three_times_daily':  return [480, 840, 1200];   // 08:00, 14:00, 20:00
    case 'every_8h':           return [480, 960, 0];      // 08:00, 16:00, 00:00
    case 'every_12h':          return [480, 1200];        // 08:00, 20:00
    case 'once_daily':
    case 'custom':
    default:                   return [ANCHOR[timing] ?? 480];
  }
}

// Greedy cluster events ({min, cls, idx}) within `windowMin`, never merging
// 'empty_stomach' with 'with_food'. Returns [{anchorMin, idxs:[], clsSet:Set}].
export function clusterEvents(events, windowMin) {
  const sorted = [...events].sort((a, b) => a.min - b.min);
  const clusters = [];
  for (const e of sorted) {
    let placed = false;
    for (const c of clusters) {
      const within = Math.abs(e.min - c.anchorMin) <= windowMin;
      const conflict = (e.cls === 'empty_stomach' && c.clsSet.has('with_food')) ||
                       (e.cls === 'with_food' && c.clsSet.has('empty_stomach'));
      if (within && !conflict) { c.idxs.push(e.idx); c.mins.push(e.min); c.clsSet.add(e.cls); placed = true; break; }
    }
    if (!placed) clusters.push({ anchorMin: e.min, idxs: [e.idx], mins: [e.min], clsSet: new Set([e.cls]) });
  }
  return clusters;
}

function minToHHMM(min) {
  const m = ((Math.round(min / 15) * 15) % 1440 + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

// Build the optimized call plan from a medicine list.
// Returns [{ local_time:'HH:MM', medicine_names:[], medicine_indexes:[] }] sorted by time.
export function optimizeCallPlan(medicines) {
  const events = [];
  medicines.forEach((m, idx) => {
    for (const min of expandDoseTimes(m.frequency, m.timing)) {
      events.push({ min, cls: m.timing === 'empty_stomach' ? 'empty_stomach' : (m.timing === 'with_food' ? 'with_food' : 'normal'), idx });
    }
  });
  const clusters = clusterEvents(events, 45);
  const plan = clusters.map(c => {
    const repMin = c.mins.reduce((a, b) => a + b, 0) / c.mins.length;
    const idxs = [...new Set(c.idxs)];
    return {
      local_time: minToHHMM(repMin),
      medicine_indexes: idxs,
      medicine_names: idxs.map(i => medicines[i].name),
    };
  });
  plan.sort((a, b) => a.local_time.localeCompare(b.local_time));
  return plan;
}
```

- [ ] **Step 4: Run → passes** (the optimizer assertions). Timezone tests come in Task 2 (same file).

- [ ] **Step 5: Commit**
```bash
git add src/reminders-schedule.js test/reminders-schedule.test.mjs
git commit -m "feat(reminders): medicine-grouping call-plan optimizer + tests"
```

---

## Task 2: DST-safe timezone → UTC computation (TDD)

**Files:** Modify `src/reminders-schedule.js`, Modify `test/reminders-schedule.test.mjs`

- [ ] **Step 1: Add failing tests** — add to the import line `zonedWallTimeToUtc, nextOccurrencesUTC`, and append before the summary:

```js
// Helper: format a UTC instant into a tz as 'HH:MM'
function hhmmInTz(iso, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

// 08:00 wall time in LA, computed to UTC, must read back as 08:00 in LA.
const utc = zonedWallTimeToUtc(2026, 7, 1, 8, 0, 'America/Los_Angeles'); // July (PDT)
eq(hhmmInTz(utc, 'America/Los_Angeles'), '08:00', 'LA 08:00 round-trips');

// nextOccurrencesUTC: next 08:00 LA within 48h from a fixed instant, read back as 08:00
const from = '2026-07-01T12:00:00.000Z';
const occ = nextOccurrencesUTC(['08:00'], 'America/Los_Angeles', from, 48);
ok(occ.length >= 1, 'at least one 08:00 occurrence in 48h');
ok(occ.every(t => hhmmInTz(t, 'America/Los_Angeles') === '08:00'), 'all occurrences read as 08:00 local');
ok(occ.every(t => new Date(t) > new Date(from)), 'all occurrences in the future');
ok(occ.every(t => new Date(t) <= new Date(Date.parse(from) + 48*3600*1000)), 'within horizon');

// DST-correctness: winter (PST, UTC-8) vs summer (PDT, UTC-7) differ by an hour in UTC
const wUtc = zonedWallTimeToUtc(2026, 1, 15, 8, 0, 'America/Los_Angeles'); // Jan PST
const sUtc = zonedWallTimeToUtc(2026, 7, 15, 8, 0, 'America/Los_Angeles'); // Jul PDT
eq(new Date(wUtc).getUTCHours(), 16, 'PST 08:00 = 16:00 UTC');
eq(new Date(sUtc).getUTCHours(), 15, 'PDT 08:00 = 15:00 UTC');
```

- [ ] **Step 2: Run → fails** (`zonedWallTimeToUtc is not a function`).

- [ ] **Step 3: Implement** — append to `src/reminders-schedule.js`:

```js
// Offset (ms) of `tz` from UTC at the given instant: (wall-clock as-if-UTC) - instant.
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Convert a wall-clock time in `tz` to a UTC ISO string (DST-safe, two-pass refine).
export function zonedWallTimeToUtc(year, month, day, hh, mm, tz) {
  const guess = Date.UTC(year, month - 1, day, hh, mm);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz); // refine for DST boundaries
  return new Date(utc).toISOString();
}

// For each 'HH:MM' local time, the UTC ISO occurrences strictly after `fromISO`
// and within `horizonHours`. Scans each day in the window.
export function nextOccurrencesUTC(localTimes, tz, fromISO, horizonHours) {
  const from = new Date(fromISO);
  const end = new Date(from.getTime() + horizonHours * 3600 * 1000);
  const out = [];
  // Determine the local calendar dates spanned, scanning a couple extra days for safety.
  for (let dayOffset = -1; dayOffset <= Math.ceil(horizonHours / 24) + 1; dayOffset++) {
    const probe = new Date(from.getTime() + dayOffset * 86400000);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' })
      .formatToParts(probe).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    for (const t of localTimes) {
      const [hh, mm] = t.split(':').map(Number);
      const iso = zonedWallTimeToUtc(+p.year, +p.month, +p.day, hh, mm, tz);
      const d = new Date(iso);
      if (d > from && d <= end) out.push(iso);
    }
  }
  return [...new Set(out)].sort();
}
```

- [ ] **Step 4: Run → all pass** (`node test/reminders-schedule.test.mjs`).

- [ ] **Step 5: Commit**
```bash
git add src/reminders-schedule.js test/reminders-schedule.test.mjs
git commit -m "feat(reminders): DST-safe timezone-to-UTC occurrence computation + tests"
```

---

## Task 3: `call_plan` + `calls` tables; compute plan at intake

**Files:** Modify `src/reminders.js`

- [ ] **Step 1: Add the two tables to `ensureSchema`** — inside the `db.batch([...])` array in `ensureSchema`, add:

```js
    db.prepare(`CREATE TABLE IF NOT EXISTS call_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      local_time TEXT NOT NULL,
      medicine_names TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      call_plan_id INTEGER,
      scheduled_at_utc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      bland_call_id TEXT,
      placed_at TEXT,
      duration_sec INTEGER,
      transcript TEXT,
      recording_url TEXT,
      cost_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_calls_sched ON calls (scheduled_at_utc, status)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_dedupe ON calls (patient_id, call_plan_id, scheduled_at_utc)`),
```

- [ ] **Step 2: Add import + `computeAndStoreCallPlan`** — at the TOP of `src/reminders.js` add:
```js
import { optimizeCallPlan } from './reminders-schedule.js';
```
Then add this function (near `handleIntakeSubmit`):
```js
// Recompute and persist a patient's call_plan from their active medicines.
export async function computeAndStoreCallPlan(db, patientId, medicines) {
  const plan = optimizeCallPlan(medicines);
  await db.prepare('UPDATE call_plan SET active = 0 WHERE patient_id = ?').bind(patientId).run();
  const stmts = plan.map(p => db.prepare(
    'INSERT INTO call_plan (patient_id, local_time, medicine_names, active) VALUES (?, ?, ?, 1)')
    .bind(patientId, p.local_time, JSON.stringify(p.medicine_names)));
  if (stmts.length) await db.batch(stmts);
  return plan;
}
```

- [ ] **Step 3: Call it from `handleIntakeSubmit`** — after the medicines are inserted and `await db.batch(stmts);` completes, add before the final `return`:
```js
  await computeAndStoreCallPlan(db, patient.id, normalized.medicines);
```

- [ ] **Step 4: Verify** — `node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0 still). Then local integration:
```bash
wrangler dev --config ./wrangler.toml --port 8793 --local > /tmp/wd.log 2>&1 &
sleep 9
curl -s -X POST http://localhost:8793/reminders/api/intake -H 'content-type: application/json' \
  -d '{"flow":"loved_one","relationship":"gma","patient":{"name":"Plan Test","phone":"4155551234","timezone":"America/Los_Angeles"},"purchaser":{"name":"P","email":"p-plan@example.com","phone":"4155550000"},"emergency":{"name":"E","phone":"4155550001","relationship":"x"},"consent":{"tcpa":true,"recording":true,"attestation":true},"medicines":[{"name":"Lisinopril","frequency":"once_daily","timing":"morning"},{"name":"VitD","frequency":"once_daily","timing":"morning"},{"name":"Melatonin","frequency":"once_daily","timing":"bedtime"}]}'
echo
wrangler d1 execute reminders --local --config ./wrangler.toml --command "SELECT local_time, medicine_names FROM call_plan WHERE active=1 ORDER BY local_time;"
kill %1 2>/dev/null
```
Expected: two active call_plan rows — `08:00` with `["Lisinopril","VitD"]` and `21:00` with `["Melatonin"]`.

- [ ] **Step 5: Commit**
```bash
git add src/reminders.js
git commit -m "feat(reminders): call_plan + calls tables; compute plan at intake"
```

---

## Task 4: Bland AI calling client

**Files:** Create `src/reminders-bland.js`

- [ ] **Step 1: Implement the client** — create `src/reminders-bland.js`:

```js
// Bland AI outbound-call client. https://docs.bland.ai
const BLAND_URL = 'https://api.bland.ai/v1/calls';

function buildTask(patientName, medicineNames) {
  const meds = medicineNames.length === 1 ? medicineNames[0]
    : medicineNames.slice(0, -1).join(', ') + ' and ' + medicineNames[medicineNames.length - 1];
  return `You are a warm, friendly medication-reminder assistant. The person you are calling is named ${patientName}. ` +
    `Start by clearly saying you are an AI assistant calling with their medication reminder. ` +
    `Gently remind them: "Hi ${patientName}, it's time to take your ${meds}." ` +
    `Ask if they have any questions or need anything. Keep it short, caring, and clear. ` +
    `If they mention a problem, a health concern, confusion, or a request, acknowledge it kindly and let them know someone will follow up. Do not give medical advice.`;
}

// Place an outbound call NOW. Returns { ok, callId } or { ok:false, error }.
export async function placeCall({ to, patientName, medicineNames, voice = 'june', from }, env) {
  return _post({ phone_number: to, task: buildTask(patientName, medicineNames), voice, record: true, max_duration: 5, wait_for_greeting: true, ...(from ? { from } : {}) }, env);
}

// Schedule an outbound call for a future UTC ISO time (best-effort redundancy).
export async function scheduleCall({ to, patientName, medicineNames, startTimeISO, voice = 'june', from }, env) {
  return _post({ phone_number: to, task: buildTask(patientName, medicineNames), voice, record: true, max_duration: 5, start_time: startTimeISO, ...(from ? { from } : {}) }, env);
}

export async function getCall(callId, env) {
  const res = await fetch(`${BLAND_URL}/${callId}`, { headers: { authorization: env.BLAND_API_KEY } });
  if (!res.ok) return { ok: false, error: `bland get ${res.status}` };
  return { ok: true, data: await res.json() };
}

async function _post(body, env) {
  try {
    const res = await fetch(BLAND_URL, {
      method: 'POST',
      headers: { authorization: env.BLAND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `bland ${res.status}: ${JSON.stringify(data).slice(0,200)}` };
    return { ok: true, callId: data.call_id || data.callId || null, raw: data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
```

- [ ] **Step 2: Verify syntax** — `node --check src/reminders-bland.js` (no output). (Live Bland calls are tested in Task 8 with the real key; do not call Bland here.)

- [ ] **Step 3: Commit**
```bash
git add src/reminders-bland.js
git commit -m "feat(reminders): Bland AI calling client (place + schedule + get)"
```

---

## Task 5: Cron entry points — pre-scheduler + reconciler

**Files:** Modify `src/reminders.js`

- [ ] **Step 1: Add imports** — at the top of `src/reminders.js` add to the bland/schedule imports:
```js
import { nextOccurrencesUTC } from './reminders-schedule.js';
import { placeCall, scheduleCall } from './reminders-bland.js';
```

- [ ] **Step 2: Add `runPreScheduler`** — append to `src/reminders.js`:
```js
// Hourly: materialize the next 48h of `calls` rows for active, approved patients,
// and best-effort pre-register each with Bland. Never let a Bland error block insertion.
export async function runPreScheduler(env, nowISO) {
  await ensureSchema(env);
  const db = env.REMINDERS_DB;
  const now = nowISO || new Date().toISOString();
  const patients = await db.prepare(
    `SELECT p.id, p.name, p.phone_e164, p.timezone FROM patients p
     JOIN accounts a ON a.id = p.account_id
     WHERE p.status = 'active' AND a.approved = 1`).all();
  let made = 0;
  for (const p of (patients.results || [])) {
    const plans = await db.prepare('SELECT id, local_time, medicine_names FROM call_plan WHERE patient_id = ? AND active = 1').bind(p.id).all();
    for (const plan of (plans.results || [])) {
      const occ = nextOccurrencesUTC([plan.local_time], p.timezone, now, 48);
      for (const iso of occ) {
        // Insert if not already present (unique index on patient+plan+time).
        const r = await db.prepare(
          `INSERT OR IGNORE INTO calls (patient_id, call_plan_id, scheduled_at_utc, status) VALUES (?, ?, ?, 'scheduled')`)
          .bind(p.id, plan.id, iso).run();
        if (r.meta && r.meta.changes > 0) {
          made++;
          // Best-effort Bland pre-registration (redundancy). Failures are non-fatal.
          try {
            const meds = JSON.parse(plan.medicine_names || '[]');
            const sc = await scheduleCall({ to: p.phone_e164, patientName: p.name, medicineNames: meds, startTimeISO: iso }, env);
            if (sc.ok && sc.callId) {
              await db.prepare(`UPDATE calls SET status='prescheduled', bland_call_id=? WHERE patient_id=? AND call_plan_id=? AND scheduled_at_utc=?`)
                .bind(sc.callId, p.id, plan.id, iso).run();
            }
          } catch {}
        }
      }
    }
  }
  return { made };
}
```

- [ ] **Step 3: Add `runReconciler`** — append:
```js
// Every minute: place any call that is due now and not yet handed off, immediately.
// This is the on-time guarantee — fully within our control.
export async function runReconciler(env, nowISO) {
  await ensureSchema(env);
  const db = env.REMINDERS_DB;
  const now = new Date(nowISO || new Date().toISOString());
  const windowStart = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10-min catch-up
  const dueAt = new Date(now.getTime() + 30 * 1000).toISOString();            // include next 30s
  // 'scheduled' = never handed to Bland; place it. 'prescheduled' = Bland has it,
  // but if it's >3 min overdue and not completed, place a fallback.
  const overdue = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const rows = await db.prepare(
    `SELECT c.id, c.patient_id, c.call_plan_id, c.scheduled_at_utc, c.status, p.name, p.phone_e164,
            (SELECT medicine_names FROM call_plan WHERE id = c.call_plan_id) AS medicine_names
     FROM calls c JOIN patients p ON p.id = c.patient_id
     WHERE c.placed_at IS NULL
       AND c.scheduled_at_utc <= ? AND c.scheduled_at_utc >= ?
       AND ( c.status = 'scheduled' OR (c.status = 'prescheduled' AND c.scheduled_at_utc <= ?) )`)
    .bind(dueAt, windowStart, overdue).all();
  let placed = 0;
  for (const r of (rows.results || [])) {
    const meds = JSON.parse(r.medicine_names || '[]');
    const res = await placeCall({ to: r.phone_e164, patientName: r.name, medicineNames: meds }, env);
    if (res.ok) {
      await db.prepare(`UPDATE calls SET status='placed', placed_at=?, bland_call_id=COALESCE(?, bland_call_id) WHERE id=?`)
        .bind(new Date().toISOString(), res.callId, r.id).run();
      placed++;
    } else {
      await db.prepare(`UPDATE calls SET status='failed', placed_at=? WHERE id=?`).bind(new Date().toISOString(), r.id).run();
    }
  }
  return { placed };
}
```

- [ ] **Step 4: Verify** — `node --check src/reminders.js`; `node test/reminders.test.mjs` (15/0).

- [ ] **Step 5: Commit**
```bash
git add src/reminders.js
git commit -m "feat(reminders): cron entry points — pre-scheduler + per-minute reconciler"
```

---

## Task 6: Wire Cloudflare cron triggers + `scheduled` handler

**Files:** Modify `wrangler.toml`, Modify `src/worker.js`

- [ ] **Step 1: Add triggers to `wrangler.toml`** — append at the end:
```toml
[triggers]
crons = ["* * * * *", "0 * * * *"]
```

- [ ] **Step 2: Add the `scheduled` export** — in `src/worker.js`, import the cron functions at the top:
```js
import { runReconciler, runPreScheduler } from './reminders.js';
```
Then add a `scheduled` method to the default export object (alongside `fetch`):
```js
  async scheduled(event, env, ctx) {
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(runPreScheduler(env));
    } else {
      // every minute
      ctx.waitUntil(runReconciler(env));
    }
  },
```

- [ ] **Step 3: Verify** — `node --check src/worker.js`. Confirm `wrangler dev` boots with triggers:
```bash
wrangler dev --config ./wrangler.toml --port 8794 --local > /tmp/wdc.log 2>&1 &
sleep 9
grep -i "cron\|trigger\|schedule" /tmp/wdc.log | head -5 || echo "(no explicit cron log; dev may not show triggers)"
# Manually invoke the scheduled handler in local dev:
curl -s "http://localhost:8794/__scheduled?cron=*+*+*+*+*" -o /dev/null -w "reconciler trigger HTTP %{http_code}\n"
kill %1 2>/dev/null
```
Expected: the `/__scheduled` curl returns HTTP 200 (wrangler dev exposes this endpoint to fire scheduled events locally). No crash in the log.

- [ ] **Step 4: Commit**
```bash
git add wrangler.toml src/worker.js
git commit -m "feat(reminders): Cloudflare cron triggers + scheduled handler"
```

---

## Task 7: Admin approval endpoint (soft-launch gate)

**Files:** Modify `src/reminders.js`

- [ ] **Step 1: Add a route** in `handleReminders`, before the page routes:
```js
  if (path === '/reminders/api/admin/approve' && request.method === 'POST') {
    return handleApprove(request, env);
  }
```

- [ ] **Step 2: Implement `handleApprove`** — owner-gated by a passcode secret. Append:
```js
async function handleApprove(request, env) {
  await ensureSchema(env);
  const auth = request.headers.get('authorization') || '';
  if (!env.REMINDERS_ADMIN_PASSCODE || auth !== `Bearer ${env.REMINDERS_ADMIN_PASSCODE}`) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  let body; try { body = await request.json(); } catch { return json({ ok:false, error:'bad json' }, 400); }
  const db = env.REMINDERS_DB;
  if (body.accountEmail) {
    await db.prepare('UPDATE accounts SET approved = 1 WHERE email = ?').bind(String(body.accountEmail).toLowerCase()).run();
  }
  if (body.activatePatientId) {
    await db.prepare("UPDATE patients SET status = 'active' WHERE id = ?").bind(body.activatePatientId).run();
  }
  return json({ ok: true });
}
```

> Note: an account must be `approved=1` AND its patient `status='active'` for the pre-scheduler to schedule calls. Approving sets both via one or two calls.

- [ ] **Step 3: Verify** — `node --check src/reminders.js`; unauthorized returns 401:
```bash
wrangler dev --config ./wrangler.toml --port 8795 --local > /tmp/wda.log 2>&1 &
sleep 9
curl -s -o /dev/null -w "no-auth=%{http_code}\n" -X POST http://localhost:8795/reminders/api/admin/approve -H 'content-type: application/json' -d '{}'
kill %1 2>/dev/null
```
Expected: `no-auth=401`.

- [ ] **Step 4: Commit**
```bash
git add src/reminders.js
git commit -m "feat(reminders): owner-gated admin approval endpoint"
```

---

## Task 8: Wire secrets + LIVE call verification (GATED — controller runs this)

**Files:** none (operational)

> This task places a REAL phone call and costs money. The controller performs it interactively with the user's confirmation of a target phone number. Do NOT dispatch a subagent for this task.

- [ ] **Step 1: Set production secrets from Doppler** (values never printed):
```bash
doppler secrets get BLAND_API_KEY --plain -p giftagent-web -c dev | npx wrangler secret put BLAND_API_KEY --config ./wrangler.toml
doppler secrets get TWILIO_ACCOUNT_SID --plain -p giftagent-web -c dev | npx wrangler secret put TWILIO_ACCOUNT_SID --config ./wrangler.toml
doppler secrets get TWILIO_AUTH_TOKEN --plain -p giftagent-web -c dev | npx wrangler secret put TWILIO_AUTH_TOKEN --config ./wrangler.toml
doppler secrets get TWILIO_PHONE_NUMBER --plain -p giftagent-web -c dev | npx wrangler secret put TWILIO_PHONE_NUMBER --config ./wrangler.toml
# Set an admin passcode (generate one; share with the user):
printf '%s' "<generated-passcode>" | npx wrangler secret put REMINDERS_ADMIN_PASSCODE --config ./wrangler.toml
```

- [ ] **Step 2: Deploy** — `npx wrangler deploy --config ./wrangler.toml`.

- [ ] **Step 3: Verify Bland `start_time` support** — confirm with the user; place one immediate test call to a user-approved number via a one-off `scheduleCall`/`placeCall` probe (or via creating a test patient + approving + a near-future call). Confirm the call connects and the agent speaks the reminder. If `start_time` errors, note that pre-scheduling redundancy is disabled and the per-minute reconciler is the sole (still-robust) mechanism.

- [ ] **Step 4: End-to-end on-time test** — create a real test patient with a call_plan time ~2 minutes out, approve it, wait for the per-minute reconciler to fire, confirm the call arrives on time and the `calls` row flips to `placed`/`completed`.

- [ ] **Step 5: Clean up** any test patient/calls rows from production.

---

## Task 9: Production verification

- [ ] **Step 1:** Confirm cron triggers are live: `npx wrangler deployments list --config ./wrangler.toml` shows the new version; the Cloudflare dashboard shows two cron triggers.
- [ ] **Step 2:** Confirm no errors in `npx wrangler tail --config ./wrangler.toml` during a couple of minute-ticks (reconciler runs, finds nothing to do on an empty queue, exits clean).
- [ ] **Step 3:** Push `main` to origin.

---

## Self-Review (completed during planning)

**Spec coverage (Phase 2):** grouping optimizer with ±45 tolerance + constraint conflicts → Task 1 ✓; group-at-same-call-time + "when to take" via timing anchors → Tasks 1,3 ✓; on-time guarantee (per-minute reconciler) + Bland-native redundancy → Tasks 5,6 ✓; DST-safe timezone handling → Task 2 ✓; soft-launch approval gate → Task 7 ✓; secrets from giftagent Doppler → Task 8 ✓.

**Deferred (correct):** Bland post-call webhook → concern detection → email+SMS alerts is **Phase 4** (not here). The `calls` table already carries `transcript`/`recording_url`/`cost_usd` columns so Phase 4 needs no migration. Dashboard to view call counts is **Phase 3**.

**Placeholder scan:** none — all logic shown in full. `<generated-passcode>` in Task 8 is an operational value the controller generates at run time, not a code placeholder.

**Type consistency:** `optimizeCallPlan` returns `{local_time, medicine_names, medicine_indexes}`; `call_plan.medicine_names` stores `JSON.stringify(medicine_names)`; cron functions parse it back. `placeCall`/`scheduleCall` return `{ok, callId}` consumed consistently in `runReconciler`/`runPreScheduler`. Table/column names match between `ensureSchema` (Task 3) and all queries (Tasks 5,7).
```
