let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'service_catalog', error: 'invalid_input' }); }
const snap = $('Services snapshot').first().json;
if (snap.forceEscalate) return JSON.stringify({ ok: false, tool: 'service_catalog', error: 'human_required' });
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'service_catalog', error: 'catalog_unavailable', retryable: true });

// Both inputs optional. Live run: even when told IDs do not exist, the model
// still opened with service_id "svc_cut". So the tool resolves the customer's
// own words (service_query) itself; an unknown explicit id is reported and the
// query, or the whole catalogue, is used instead.
function containsTerm(hay, term) {
  const t = String(term ?? '').trim().toLowerCase(), h = String(hay ?? '').toLowerCase();
  if (!t || !h) return false;
  if (/[㐀-鿿]/.test(t) || /[㐀-鿿]/.test(h)) return h.includes(t);
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(h);
}
const active = snap.rows.filter(r => r.active === true && Number.isFinite(Number(r.price)) && Number(r.price) >= 0 && r.currency);
function resolveService(text) {
  const qy = String(text ?? '').trim().toLowerCase();
  if (!qy) return null;
  const scored = active.map(r => {
    let best = 0;
    for (const t of [r.service_id, r.name, r.name_zh].map(x => String(x ?? '').trim()).filter(Boolean)) {
      if (containsTerm(qy, t)) best = Math.max(best, t.length);
      else if (containsTerm(t, qy)) best = Math.max(best, qy.length / 2);
    }
    return { r, best };
  }).filter(x => x.best > 0).sort((a, b) => b.best - a.best || String(a.r.service_id).localeCompare(String(b.r.service_id)));
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].best === scored[1].best) return null;
  return scored[0].r;
}
const explicitId = String(q.service_id ?? '').trim();
const knownId = !!explicitId && active.some(r => r.service_id === explicitId);
const resolved = knownId ? null : resolveService(q.service_query);
const wanted = knownId ? explicitId : (resolved ? resolved.service_id : '');
const rows = wanted ? active.filter(r => r.service_id === wanted) : active;
return JSON.stringify({
  ok: true, tool: 'service_catalog',
  filtered_by_service_id: wanted || null,
  unknown_service_id: !!(explicitId && !knownId),
  resolved_from_query: resolved ? resolved.service_id : null,
  services: rows
});
