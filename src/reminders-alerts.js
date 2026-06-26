// Reminders — post-call need detection + alert delivery.

// Normalize Bland's webhook payload to the fields we use.
export function normalizeBlandWebhook(body) {
  body = body || {};
  let transcript = '';
  if (typeof body.concatenated_transcript === 'string') transcript = body.concatenated_transcript;
  else if (Array.isArray(body.transcripts)) transcript = body.transcripts.map(t => `${t.user || t.role || 'speaker'}: ${t.text || ''}`).join('\n');
  const lenMin = typeof body.call_length === 'number' ? body.call_length : (typeof body.corrected_duration === 'number' ? body.corrected_duration / 60 : 0);
  return {
    callId: body.call_id || body.callId || null,
    status: body.status || (body.completed ? 'completed' : 'unknown'),
    answeredByHuman: body.answered_by === 'human',
    answeredBy: body.answered_by || null,
    completed: !!body.completed,
    durationSec: Math.round(lenMin * 60),
    recordingUrl: body.recording_url || null,
    transcript,
    costUsd: typeof body.price === 'number' ? body.price : null,
  };
}

// Build the gpt-4o-mini classification messages.
export function buildConcernPrompt(patientName, transcript) {
  return [
    { role: 'system', content:
      'You analyze a transcript of an automated medication-reminder phone call to an elderly person. ' +
      'Decide if a human caregiver should be alerted. Alert if the person: expresses confusion about their medication, ' +
      'asks a question that needs follow-up, reports a health problem or symptom, refuses or says they will skip the medication, ' +
      'sounds distressed, or asks for help. Do NOT alert for a normal, friendly acknowledgement. ' +
      'Respond with ONLY a compact JSON object: {"concern": boolean, "severity": "none"|"low"|"medium"|"high", ' +
      '"category": "none"|"question"|"health"|"refusal"|"confusion"|"help", "summary": "one short sentence"}.' },
    { role: 'user', content: `Patient: ${patientName}\nTranscript:\n${transcript || '(no transcript available)'}` },
  ];
}

// Parse the model's reply into a safe object (default: no concern).
export function parseConcernResponse(text) {
  const safe = { concern: false, severity: 'none', category: 'none', summary: '' };
  if (!text) return safe;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return safe;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return {
      concern: !!o.concern,
      severity: ['none','low','medium','high'].includes(o.severity) ? o.severity : (o.concern ? 'medium' : 'none'),
      category: typeof o.category === 'string' ? o.category : 'none',
      summary: typeof o.summary === 'string' ? o.summary : '',
    };
  } catch { return safe; }
}

// Build a human-readable alert (subject + plaintext + html).
export function formatAlert({ patientName, kind, summary, transcript, recordingUrl, detectedAtISO }) {
  const label = kind === 'no_answer' ? 'did not answer their reminder call'
    : kind === 'failed' ? 'reminder call could not be completed'
    : 'may need help after their reminder call';
  const subject = `Reminders alert: ${patientName} ${label}`;
  const lines = [
    `${patientName} ${label}.`,
    summary ? `\nWhat happened: ${summary}` : '',
    detectedAtISO ? `\nTime: ${detectedAtISO}` : '',
    recordingUrl ? `\nCall recording: ${recordingUrl}` : '',
    transcript ? `\n\nTranscript:\n${transcript}` : '',
    `\n\n— Reminders (this is an automated safety alert; Reminders is not a substitute for emergency services).`,
  ];
  const text = lines.filter(Boolean).join('');
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5">` +
    `<h2 style="margin:0 0 8px">${escapeHtml(patientName)} ${escapeHtml(label)}</h2>` +
    (summary ? `<p><strong>What happened:</strong> ${escapeHtml(summary)}</p>` : '') +
    (detectedAtISO ? `<p><strong>Time:</strong> ${escapeHtml(detectedAtISO)}</p>` : '') +
    (recordingUrl ? `<p><a href="${escapeHtml(recordingUrl)}">Listen to the call recording</a></p>` : '') +
    (transcript ? `<pre style="white-space:pre-wrap;background:#f5f5f7;padding:12px;border-radius:8px">${escapeHtml(transcript)}</pre>` : '') +
    `<p style="color:#888;font-size:13px">Automated safety alert — Reminders is not a substitute for emergency services.</p></div>`;
  return { subject, text, html };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// --- I/O ---

export async function detectConcern(patientName, transcript, env) {
  if (!transcript || !env.OPENAI_API_KEY) return { concern: false, severity: 'none', category: 'none', summary: '' };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, messages: buildConcernPrompt(patientName, transcript) }),
    });
    if (!res.ok) return { concern: false, severity: 'none', category: 'none', summary: '' };
    const data = await res.json();
    return parseConcernResponse(data.choices?.[0]?.message?.content || '');
  } catch { return { concern: false, severity: 'none', category: 'none', summary: '' }; }
}

export async function sendResendEmail({ to, subject, html, text }, env) {
  if (!env.RESEND_API_KEY || !to) return { ok: false, error: 'no key/recipient' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'Reminders <reminders@mail.giftanagent.com>', to: Array.isArray(to) ? to : [to], subject, html, text }),
  });
  return { ok: res.ok, status: res.status };
}

export async function sendTwilioSms({ to, body }, env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER || !to) return { ok: false, error: 'twilio not configured' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: env.TWILIO_PHONE_NUMBER, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { ok: res.ok, status: res.status };
}
