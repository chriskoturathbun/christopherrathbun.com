// Run: node test/reminders-alerts.test.mjs
import { normalizeBlandWebhook, buildConcernPrompt, parseConcernResponse, formatAlert } from '../src/reminders-alerts.js';

let pass = 0, fail = 0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('FAIL:',m); } }
function eq(a,b,m){ ok(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const wh = normalizeBlandWebhook({
  call_id: 'abc', answered_by: 'human', completed: true, call_length: 1.5,
  recording_url: 'https://rec/x.mp3',
  concatenated_transcript: "assistant: time for your meds\nuser: what is this pill for?",
});
eq(wh.callId, 'abc', 'callId');
eq(wh.answeredByHuman, true, 'answered by human');
eq(wh.durationSec, 90, 'call_length minutes → seconds');
eq(wh.recordingUrl, 'https://rec/x.mp3', 'recording url');
ok(wh.transcript.includes('what is this pill for'), 'transcript text');

const wh2 = normalizeBlandWebhook({ call_id: 'd', answered_by: 'no-answer', completed: false });
eq(wh2.answeredByHuman, false, 'no-answer → not human');

const msgs = buildConcernPrompt('Rose', 'user: I feel dizzy');
ok(Array.isArray(msgs), 'returns messages array');
ok(JSON.stringify(msgs).includes('Rose'), 'prompt names patient');
ok(JSON.stringify(msgs).includes('I feel dizzy'), 'prompt includes transcript');

const a = parseConcernResponse('{"concern":true,"severity":"high","category":"health","summary":"dizzy"}');
eq(a.concern, true, 'parsed concern'); eq(a.severity, 'high', 'parsed severity');
const b = parseConcernResponse('```json\n{"concern":false,"severity":"none","category":"none","summary":"ok"}\n```');
eq(b.concern, false, 'parsed fenced');
const c = parseConcernResponse('garbage not json');
eq(c.concern, false, 'malformed → safe default no-concern'); eq(c.severity, 'none', 'malformed severity none');

const al = formatAlert({ patientName:'Rose', kind:'concern', summary:'asked what a pill is for', transcript:'...', recordingUrl:'https://rec', detectedAtISO:'2026-06-26T15:00:00Z' });
ok(al.subject.toLowerCase().includes('rose'), 'subject names patient');
ok(al.text.includes('asked what a pill is for'), 'body includes summary');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
