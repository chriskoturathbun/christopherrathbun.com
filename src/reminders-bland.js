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
