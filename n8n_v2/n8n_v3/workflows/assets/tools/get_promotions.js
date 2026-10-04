let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'get_promotions', error: 'invalid_input' }); }
const snap = $('Promotions snapshot').first().json;
if (snap.forceEscalate) return JSON.stringify({ ok: false, tool: 'get_promotions', error: 'human_required' });
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'get_promotions', error: 'catalog_unavailable', retryable: true });

// --- name -> ID resolution -------------------------------------------------
// Live run showed the model inventing "svc_cut" because the routing rule
// ("offers question -> get_promotions ONLY") left it no way to learn a real ID.
// Structural fix: the tool resolves the customer's own words itself, so the
// model never needs to know an ID. The resolved service is returned as
// evidence so the guardrail can accept it.
function containsTerm(hay, term) {
  const t = String(term ?? '').trim().toLowerCase(), h = String(hay ?? '').toLowerCase();
  if (!t || !h) return false;
  if (/[㐀-鿿]/.test(t) || /[㐀-鿿]/.test(h)) return h.includes(t);
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(h);
}
const serviceRows = ($('Services snapshot').first().json.rows || []);
function resolveService(text) {
  const qy = String(text ?? '').trim().toLowerCase();
  if (!qy) return null;
  const scored = serviceRows.filter(r => r.active === true).map(r => {
    let best = 0;
    for (const t of [r.service_id, r.name, r.name_zh].map(x => String(x ?? '').trim()).filter(Boolean)) {
      if (containsTerm(qy, t)) best = Math.max(best, t.length);            // customer said the whole name
      else if (containsTerm(t, qy)) best = Math.max(best, qy.length / 2);  // customer said part of it
    }
    return { r, best };
  }).filter(x => x.best > 0).sort((a, b) => b.best - a.best || String(a.r.service_id).localeCompare(String(b.r.service_id)));
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].best === scored[1].best) return null;  // ambiguous: do not guess
  const r = scored[0].r;
  return { service_id: r.service_id, name: r.name, name_zh: r.name_zh, price: r.price, currency: r.currency, duration_min: r.duration_min };
}
const explicitId = String(q.service_id ?? '').trim();
const knownId = !!explicitId && serviceRows.some(r => r.service_id === explicitId);
const resolved = knownId ? null : resolveService(q.service_query);
const wanted = knownId ? explicitId : (resolved ? resolved.service_id : '');

// --- validity window in salon-local time ----------------------------------
const TZ = 'Australia/Sydney';
function tzOffsetMs(d) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const part of dtf.formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value;
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, Number(p.minute), Number(p.second)) - d.getTime();
}
function localBoundary(value, endOfDay) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  // bare date, or a `date` column serialised as midnight UTC: both mean "that calendar day"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const H = endOfDay ? 23 : 0, M = endOfDay ? 59 : 0, S = endOfDay ? 59 : 0, MS = endOfDay ? 999 : 0;
  let ts = Date.UTC(y, mo, d, H, M, S, MS);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo, d, H, M, S, MS) - tzOffsetMs(new Date(ts));
  return ts;
}

const now = Date.now();
const rows = snap.rows.filter(r => {
  try {
    if (r.active !== true) return false;
    const from = localBoundary(r.valid_from, false), to = localBoundary(r.valid_to, true);
    if (from === null || to === null) return false;
    if (now < from || now > to) return false;
    const channels = JSON.parse(r.channels || '[]');
    if (!(channels.includes('web') || channels.includes('all'))) return false;
    const e = JSON.parse(r.eligibility || '{}');
    // Anonymous internal prototype: only promos with no per-customer conditions
    // can be verified. Documented limitation, not a silent drop.
    if (e.everyone !== true) return false;
    if (!Object.keys(e).every(k => ['everyone', 'service_ids'].includes(k))) return false;
    if (e.service_ids && (!wanted || !e.service_ids.includes(wanted))) return false;
    return true;
  } catch { return false; }
});
return JSON.stringify({
  ok: true, tool: 'get_promotions',
  timezone: TZ,
  filtered_by_service_id: wanted || null,
  unknown_service_id: explicitId && !knownId ? explicitId : null,
  resolved_service: resolved,
  promotions: rows
});
