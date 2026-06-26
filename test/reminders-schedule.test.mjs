// Run: node test/reminders-schedule.test.mjs
import { expandDoseTimes, clusterEvents, optimizeCallPlan } from '../src/reminders-schedule.js';

let pass = 0, fail = 0;
function ok(c, m){ if(c) pass++; else { fail++; console.error('FAIL:', m); } }
function eq(a, b, m){ ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function deq(a, b, m){ ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

deq(expandDoseTimes('once_daily','morning'), [480], 'once morning = 08:00');
deq(expandDoseTimes('once_daily','bedtime'), [1260], 'once bedtime = 21:00');
deq(expandDoseTimes('twice_daily','morning'), [480,1200], 'twice = 08:00,20:00');
deq(expandDoseTimes('every_8h','morning'), [480,960,0], 'every_8h = 08:00,16:00,00:00');
deq(expandDoseTimes('every_12h','morning'), [480,1200], 'every_12h = 08:00,20:00');
deq(expandDoseTimes('three_times_daily','noon'), [480,840,1200], '3x = 08:00,14:00,20:00');

const ev = [
  { min: 480, cls: 'normal', idx: 0 },
  { min: 500, cls: 'normal', idx: 1 },
  { min: 1260, cls: 'normal', idx: 2 },
];
const cl = clusterEvents(ev, 45);
eq(cl.length, 2, 'two clusters');
deq(cl[0].idxs, [0,1], 'A+B grouped');
deq(cl[1].idxs, [2], 'C alone');

const ev2 = [
  { min: 480, cls: 'with_food', idx: 0 },
  { min: 490, cls: 'empty_stomach', idx: 1 },
];
const cl2 = clusterEvents(ev2, 45);
eq(cl2.length, 2, 'conflicting constraints stay separate');

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
