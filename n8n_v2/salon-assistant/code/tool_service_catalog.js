let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'service_catalog', error: 'invalid_input' }); }
const conv = $('Conversation state').first().json;
if (conv.forceEscalate) return JSON.stringify({ ok: false, tool: 'service_catalog', error: 'human_required' });
const snap = $('Services snapshot').first().json;
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'service_catalog', error: 'catalog_unavailable', retryable: true });

function containsTerm(hay, term) {
  const t = String(term ?? '').trim().toLowerCase(), h = String(hay ?? '').toLowerCase();
  if (!t || !h) return false;
  if (/[\u3400-\u9fff]/.test(t) || /[\u3400-\u9fff]/.test(h)) return h.includes(t);
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

// The customer's own words are the authority. Only if they match nothing do we
// fall back to the model's paraphrase, and then the result is flagged so it
// cannot silently enter the slot state (live run: "shorter and fresher" was
// rewritten into a query that matched an unrelated service).
const explicitId = String(q.service_id ?? '').trim();
const knownId = !!explicitId && active.some(r => r.service_id === explicitId);
let resolved = null, resolvedFrom = null;
if (!knownId) {
  resolved = resolveService(conv.chatInput);
  if (resolved) resolvedFrom = 'customer_text';
  else { resolved = resolveService(q.service_query); if (resolved) resolvedFrom = 'model_paraphrase'; }
}
const wanted = knownId ? explicitId : (resolved ? resolved.service_id : '');
const rows = wanted ? active.filter(r => r.service_id === wanted) : active;
return JSON.stringify({
  ok: true, tool: 'service_catalog',
  filtered_by_service_id: wanted || null,
  unknown_service_id: !!(explicitId && !knownId),
  resolved_from: resolvedFrom,
  services: rows,
  ...(String(q.service_query ?? '').trim() && !resolved ? { result: 'NO_MATCHING_SERVICE', final_instruction: 'No service matches "' + String(q.service_query).replace(/[\r\n"\\]/g, ' ').trim().slice(0, 40) + '". The complete catalogue is listed above; if none of it is what the customer asked for, the salon does not offer that service. Do NOT call any other tool. Answer now with intent=catalog and service_ids=[] (or the matching id from the list), escalate=false.' } : {})
});
