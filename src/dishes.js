// Dish Chooser — menu-photo → dish list, powering /choosing-dishes.
// POST /api/menu-scan  { images: ["data:image/jpeg;base64,...", ...] }
//   → { dishes: [{ name, section, price }] }
// Uses the same OPENAI_API_KEY secret as the reminders concern-detection.

const MAX_IMAGES = 4;
const MAX_DATAURL_CHARS = 3_800_000; // ~2.8 MB binary per image
const MAX_DISHES = 80;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function buildMessages(images) {
  const content = [
    {
      type: 'text',
      text:
        'These photos are pages of a restaurant menu. Extract every distinct orderable dish.\n' +
        'Return STRICT JSON only, shaped exactly like:\n' +
        '{"dishes":[{"name":"Pad Thai","section":"Noodles","price":"$14"}]}\n' +
        'Rules:\n' +
        '- name: the dish name as printed (title case, no description, max 60 chars).\n' +
        '- section: the menu heading it appears under (e.g. "Appetizers", "Mains", "Desserts"); use "Menu" if there is no heading.\n' +
        '- price: as printed (e.g. "$12.95"), or null if not shown.\n' +
        '- Include food and notable drinks; skip modifiers, sides listed inside descriptions, and add-ons.\n' +
        '- Deduplicate. At most ' + MAX_DISHES + ' dishes. If no menu is visible, return {"dishes":[]}.',
    },
  ];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: img, detail: 'auto' } });
  }
  return [{ role: 'user', content }];
}

function cleanDishes(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const d of raw) {
    if (!d || typeof d.name !== 'string') continue;
    const name = d.name.trim().slice(0, 60);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      section: (typeof d.section === 'string' && d.section.trim().slice(0, 40)) || 'Menu',
      price: typeof d.price === 'string' ? d.price.trim().slice(0, 12) : null,
    });
    if (out.length >= MAX_DISHES) break;
  }
  return out;
}

export async function handleDishes(request, env, url) {
  if (url.pathname !== '/api/menu-scan') return json({ error: 'not found' }, 404);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.OPENAI_API_KEY) return json({ error: 'scanner not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }

  const images = Array.isArray(body?.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!images.length) return json({ error: 'no images' }, 400);
  for (const img of images) {
    if (typeof img !== 'string' || !img.startsWith('data:image/') || img.length > MAX_DATAURL_CHARS) {
      return json({ error: 'each image must be a data:image/* URL under ~2.8 MB' }, 400);
    }
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: buildMessages(images),
      }),
    });
    if (!res.ok) return json({ error: 'menu scan failed (' + res.status + ')' }, 502);
    const data = await res.json();
    let parsed;
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); }
    catch { return json({ error: 'could not read the menu — try a clearer photo' }, 502); }
    return json({ dishes: cleanDishes(parsed.dishes) });
  } catch {
    return json({ error: 'menu scan failed — try again' }, 502);
  }
}
