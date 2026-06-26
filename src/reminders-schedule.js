// Reminders — scheduling: dose-time expansion, grouping optimizer, timezone math. PURE.

const ANCHOR = { morning:480, noon:720, evening:1080, bedtime:1260, with_food:480, empty_stomach:420, specific_time:540 };

// Return dose times (minutes since local midnight) for a medicine's frequency + timing.
export function expandDoseTimes(frequency, timing) {
  switch (frequency) {
    case 'twice_daily':        return [480, 1200];
    case 'three_times_daily':  return [480, 840, 1200];
    case 'every_8h':           return [480, 960, 0];
    case 'every_12h':          return [480, 1200];
    case 'once_daily':
    case 'custom':
    default:                   return [ANCHOR[timing] ?? 480];
  }
}

// Greedy cluster events ({min, cls, idx}) within `windowMin`, never merging
// 'empty_stomach' with 'with_food'. Returns [{anchorMin, idxs:[], mins:[], clsSet:Set}].
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
  utc = guess - tzOffsetMs(new Date(utc), tz);
  return new Date(utc).toISOString();
}

// For each 'HH:MM' local time, the UTC ISO occurrences strictly after `fromISO`
// and within `horizonHours`. Scans each day in the window.
export function nextOccurrencesUTC(localTimes, tz, fromISO, horizonHours) {
  const from = new Date(fromISO);
  const end = new Date(from.getTime() + horizonHours * 3600 * 1000);
  const out = [];
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
