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
