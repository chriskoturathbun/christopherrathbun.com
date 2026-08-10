#!/usr/bin/env node
// Generates the static AI-innovators section from people.json.
// Usage: node scripts/ai-innovators/build.mjs
//   BASE=/20under20 OUT=/path/to/site/20under20 node scripts/ai-innovators/build.mjs
// BASE is the URL mount path (default /ai-innovators); OUT is the output dir.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const people = JSON.parse(readFileSync(join(here, 'people.json'), 'utf8'));
const BASE = (process.env.BASE || '/ai-innovators').replace(/\/$/, '');
const BRAND = process.env.BRAND || 'Christopher Rathbun';
const outDir = process.env.OUT || join(here, '..', '..', 'public', 'ai-innovators');
mkdirSync(outDir, { recursive: true });
// clear stale generated pages (keep nothing hand-authored in this dir)
for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { recursive: true });

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const initials = name => name.split(/[\s(]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const googleImages = p => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(p.name.replace(/\s*\(.*\)/, '') + ' ' + p.org.split('/')[0].trim())}`;
const wikiUrl = t => `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`;

const CATEGORY_ORDER = ['Frontier Labs', 'Foundation Models', 'Big Tech', 'Startups', 'Robotics & Autonomy', 'Research & Science', 'Chips & Research'];
const byCountry = { US: people.filter(p => p.country === 'US'), China: people.filter(p => p.country === 'China') };

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />`;

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0c0c0c;--card:#111;--card-hover:#161616;--border:#222;--text:#e8e8e8;--text-muted:#666;--text-dim:#333;--accent:#e8e8e8}
body{font-family:'Space Mono','Courier New',monospace;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:1200px;margin:0 auto;padding:0 28px}
nav{padding:20px 28px;display:flex;align-items:center;justify-content:space-between;max-width:1200px;margin:0 auto}
.nav-name{font-size:.75rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
.nav-name:hover{color:var(--text)}
.nav-right{font-size:.72rem;letter-spacing:.08em;color:var(--text-muted)}
.grotesk{font-family:'Space Grotesk',sans-serif}
.tag{display:inline-block;font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);border:1px solid var(--border);padding:3px 8px;border-radius:2px}
footer{border-top:1px solid var(--border);margin-top:80px;padding:28px;text-align:center;font-size:.7rem;color:var(--text-muted);letter-spacing:.08em}
footer a{text-decoration:underline}
img.headshot{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .4s}
img.headshot.loaded{opacity:1}
.ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:700;color:var(--text-dim);background:linear-gradient(135deg,#141414,#0e0e0e)}
`;

const PHOTO_JS = readFileSync(join(here, 'wiki-photo.js'), 'utf8');

/* ───────────────────────── index page ───────────────────────── */

function cardHTML(p, i) {
  const num = String(i + 1).padStart(3, '0');
  return `      <a class="pcard" href="${BASE}/${p.slug}" data-country="${p.country}" data-category="${esc(p.category)}" data-name="${esc((p.name + ' ' + (p.zh || '') + ' ' + p.org).toLowerCase())}">
        <div class="pcard-img" data-wiki="${p.wiki ? esc(p.wiki) : ''}"><div class="ph" style="font-size:2rem">${esc(initials(p.name))}</div></div>
        <div class="pcard-body">
          <div class="pcard-num">[ ${num} ]</div>
          <div class="pcard-name grotesk">${esc(p.name)}${p.zh ? ` <span class="zh">${esc(p.zh)}</span>` : ''}</div>
          <div class="pcard-role">${esc(p.role)} · ${esc(p.org)}</div>
          <div class="pcard-tags"><span class="tag">${p.country === 'US' ? 'United States' : 'China'}</span><span class="tag">${esc(p.category)}</span></div>
        </div>
      </a>`;
}

const indexHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Innovators — Global Innovators in Business Longlist</title>
  <meta name="description" content="100 AI innovators across the United States and China — the outreach longlist for the Global Innovators in Business annual award." />
  ${FONTS}
  <style>
${BASE_CSS}
.hero{padding:70px 0 40px}
.hero h1{font-family:'Space Grotesk',sans-serif;font-size:clamp(2.6rem,7vw,5.5rem);font-weight:700;letter-spacing:-.03em;line-height:.95;text-transform:uppercase}
.hero h1 .dim{color:#202020}
.hero p{margin-top:22px;font-size:.85rem;color:var(--text-muted);max-width:640px}
.controls{display:flex;flex-wrap:wrap;gap:10px;margin:34px 0 8px;align-items:center}
.fbtn{font-family:inherit;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;background:none;border:1px solid var(--border);color:var(--text-muted);padding:7px 14px;border-radius:2px;cursor:pointer}
.fbtn:hover{color:var(--text);border-color:#444}
.fbtn.on{color:var(--bg);background:var(--text);border-color:var(--text)}
#q{font-family:inherit;font-size:.75rem;background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:2px;min-width:220px;flex:1;max-width:340px}
#q:focus{outline:none;border-color:#444}
.count{font-size:.68rem;color:var(--text-muted);letter-spacing:.08em;margin-left:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin-top:26px}
.pcard{background:var(--card);border:1px solid var(--border);border-radius:3px;overflow:hidden;display:flex;flex-direction:column;transition:background .15s,border-color .15s,transform .15s}
.pcard:hover{background:var(--card-hover);border-color:#3a3a3a;transform:translateY(-2px)}
.pcard-img{position:relative;aspect-ratio:1/1;background:#101010;overflow:hidden}
.pcard-body{padding:14px 16px 16px}
.pcard-num{font-size:.62rem;color:var(--text-dim);letter-spacing:.1em}
.pcard-name{font-size:1.05rem;font-weight:600;margin-top:6px;line-height:1.25}
.pcard-name .zh{font-weight:400;color:var(--text-muted);font-size:.85em}
.pcard-role{font-size:.68rem;color:var(--text-muted);margin-top:5px;line-height:1.45}
.pcard-tags{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.hidden{display:none}
  </style>
</head>
<body>
  <nav><a class="nav-name" href="/">${esc(BRAND)}</a><span class="nav-right">AI Innovators / 100</span></nav>
  <main class="wrap">
    <header class="hero">
      <h1>AI<br/>Innovators<br/><span class="dim">US × China</span></h1>
      <p>The outreach longlist for the <strong>Global Innovators in Business</strong> annual award — 100 people building the AI era across the United States and China. Ten will be selected.</p>
    </header>
    <div class="controls">
      <button class="fbtn on" data-f="country" data-v="">All</button>
      <button class="fbtn" data-f="country" data-v="US">United States</button>
      <button class="fbtn" data-f="country" data-v="China">China</button>
      <input id="q" type="search" placeholder="Search name / company…" />
      <span class="count" id="count">100 / 100</span>
    </div>
    <div class="controls" id="catRow">
      <button class="fbtn on" data-f="category" data-v="">All categories</button>
${CATEGORY_ORDER.map(c => `      <button class="fbtn" data-f="category" data-v="${esc(c)}">${esc(c)}</button>`).join('\n')}
    </div>
    <div class="grid" id="grid">
${people.map(cardHTML).join('\n')}
    </div>
  </main>
  <footer>Headshots load live from Wikipedia / Wikimedia Commons and remain the property of their photographers — each profile page carries the full credit and license.</footer>
  <script>
${PHOTO_JS}
  (function(){
    var state={country:'',category:'',q:''};
    var cards=[].slice.call(document.querySelectorAll('.pcard'));
    function apply(){
      var n=0;
      cards.forEach(function(c){
        var ok=(!state.country||c.dataset.country===state.country)&&(!state.category||c.dataset.category===state.category)&&(!state.q||c.dataset.name.indexOf(state.q)!==-1);
        c.classList.toggle('hidden',!ok); if(ok)n++;
      });
      document.getElementById('count').textContent=n+' / '+cards.length;
    }
    [].forEach.call(document.querySelectorAll('.fbtn'),function(b){
      b.addEventListener('click',function(){
        state[b.dataset.f]=b.dataset.v;
        [].forEach.call(document.querySelectorAll('.fbtn[data-f='+b.dataset.f+']'),function(x){x.classList.toggle('on',x===b);});
        apply();
      });
    });
    document.getElementById('q').addEventListener('input',function(e){state.q=e.target.value.toLowerCase().trim();apply();});
    // lazy-load headshot thumbnails in batches via the Wikipedia API
    var slots=[].slice.call(document.querySelectorAll('.pcard-img[data-wiki]')).filter(function(s){return s.dataset.wiki;});
    WikiPhoto.loadThumbs(slots,400);
  })();
  </script>
</body>
</html>
`;
writeFileSync(join(outDir, 'index.html'), indexHTML);

/* ───────────────────────── person pages ───────────────────────── */

function personHTML(p, i) {
  const prev = people[(i - 1 + people.length) % people.length];
  const next = people[(i + 1) % people.length];
  const num = String(i + 1).padStart(3, '0');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(p.name)} — AI Innovators</title>
  <meta name="description" content="${esc(p.role)} at ${esc(p.org)} — nominee, Global Innovators in Business award longlist." />
  ${FONTS}
  <style>
${BASE_CSS}
.back{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);display:inline-block;margin:34px 0 26px}
.back:hover{color:var(--text)}
.layout{display:grid;grid-template-columns:340px 1fr;gap:44px;align-items:start}
@media(max-width:760px){.layout{grid-template-columns:1fr}}
.photo{position:relative;aspect-ratio:4/5;background:#101010;border:1px solid var(--border);border-radius:3px;overflow:hidden}
.credit{font-size:.62rem;color:var(--text-muted);margin-top:10px;line-height:1.6;min-height:1em}
.credit a{text-decoration:underline}
.num{font-size:.68rem;color:var(--text-dim);letter-spacing:.12em}
h1{font-family:'Space Grotesk',sans-serif;font-size:clamp(2rem,5vw,3.4rem);font-weight:700;letter-spacing:-.02em;line-height:1.02;margin-top:10px;text-transform:uppercase}
.zh{font-family:'Space Grotesk',sans-serif;font-weight:400;color:var(--text-muted);font-size:1.3rem;margin-top:6px}
.role{font-size:.85rem;color:var(--text);margin-top:16px}
.role span{color:var(--text-muted)}
.tags{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.blurb{margin-top:28px;font-size:.88rem;line-height:1.85;color:#c9c9c9;max-width:640px}
.links{margin-top:32px;display:flex;gap:12px;flex-wrap:wrap}
.lbtn{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--border);padding:9px 16px;border-radius:2px;color:var(--text-muted)}
.lbtn:hover{color:var(--text);border-color:#444}
.pn{display:flex;justify-content:space-between;margin-top:70px;padding-top:24px;border-top:1px solid var(--border);font-size:.7rem;letter-spacing:.08em}
.pn a{color:var(--text-muted)}.pn a:hover{color:var(--text)}
  </style>
</head>
<body>
  <nav><a class="nav-name" href="/">${esc(BRAND)}</a><span class="nav-right">Global Innovators in Business · Longlist</span></nav>
  <main class="wrap">
    <a class="back" href="${BASE}/">← All 100 innovators</a>
    <div class="layout">
      <div>
        <div class="photo" id="photoBox" data-wiki="${p.wiki ? esc(p.wiki) : ''}"><div class="ph" style="font-size:4.5rem">${esc(initials(p.name))}</div></div>
        <div class="credit" id="credit">${p.wiki ? 'Loading photo & credit from Wikimedia…' : `No freely licensed photo found — <a href="${esc(googleImages(p))}" target="_blank" rel="noopener">search Google Images ↗</a>`}</div>
      </div>
      <div>
        <div class="num">[ ${num} / 100 ]</div>
        <h1>${esc(p.name)}</h1>
        ${p.zh ? `<div class="zh">${esc(p.zh)}</div>` : ''}
        <div class="role">${esc(p.role)} <span>· ${esc(p.org)}</span></div>
        <div class="tags"><span class="tag">${p.country === 'US' ? 'United States' : 'China'}</span><span class="tag">${esc(p.category)}</span></div>
        <p class="blurb">${esc(p.blurb)}</p>
        <div class="links">
          ${p.wiki ? `<a class="lbtn" href="${esc(wikiUrl(p.wiki))}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}
          <a class="lbtn" href="${esc(googleImages(p))}" target="_blank" rel="noopener">Google Images ↗</a>
        </div>
      </div>
    </div>
    <div class="pn">
      <a href="${BASE}/${prev.slug}">← ${esc(prev.name)}</a>
      <a href="${BASE}/${next.slug}">${esc(next.name)} →</a>
    </div>
  </main>
  <footer>Photo loads live from Wikipedia / Wikimedia Commons; it remains the property of its photographer under the license shown above. · <a href="${BASE}/">AI Innovators index</a></footer>
  <script>
${PHOTO_JS}
  WikiPhoto.loadPortrait(document.getElementById('photoBox'), document.getElementById('credit'), ${JSON.stringify(googleImages(p))});
  </script>
</body>
</html>
`;
}

people.forEach((p, i) => writeFileSync(join(outDir, `${p.slug}.html`), personHTML(p, i)));

console.log(`Built ${people.length} person pages + index into ${outDir} (base ${BASE})`);
console.log(`${people.filter(p => p.wiki).length} with Wikipedia photos, ${people.filter(p => !p.wiki).length} with placeholder fallback`);
