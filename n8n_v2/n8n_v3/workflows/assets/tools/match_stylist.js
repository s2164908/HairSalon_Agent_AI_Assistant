let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'match_stylist', error: 'invalid_input' }); }
const snap = $('Stylists snapshot').first().json;
if (snap.forceEscalate) return JSON.stringify({ ok: false, tool: 'match_stylist', error: 'human_required' });
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'match_stylist', error: 'catalog_unavailable', retryable: true });

const arr = x => { try { const a = JSON.parse(x || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

// --- style name -> taxonomy ID resolution -----------------------------------
// Live run: the model passed taxonomy_id "sty_cut" (invented) because the routing
// rule left it no way to classify first. The tool now resolves style_query itself
// with the same longest-match rule as classify_style and returns the resolved
// style as evidence. An unknown taxonomy_id is reported, never silently scored.
function matchLen(hay, term) {
  const t = String(term ?? '').trim().toLowerCase();
  if (!t) return 0;
  if (/[㐀-鿿]/.test(t)) return hay.includes(t) ? t.length : 0;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(hay) ? t.length : 0;
}
const taxRows = ($('Taxonomy snapshot').first().json.rows || []);
function resolveStyle(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const scored = taxRows.map(r => {
    const lens = [r.name_en, r.name_zh, r.taxonomy_id, ...arr(r.aliases)].map(t => matchLen(s, t));
    return { r, len: Math.max(0, ...lens) };
  }).filter(x => x.len > 0).sort((a, b) => b.len - a.len || String(a.r.taxonomy_id).localeCompare(String(b.r.taxonomy_id)));
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].len === scored[1].len) return null;  // genuine tie: do not guess
  const r = scored[0].r;
  return { taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh };
}
const explicitTax = String(q.taxonomy_id ?? '').trim();
const knownTax = !!explicitTax && taxRows.some(r => r.taxonomy_id === explicitTax);
const resolved = knownTax ? null : resolveStyle(q.style_query);
const taxonomyId = knownTax ? explicitTax : (resolved ? resolved.taxonomy_id : '');
// Live run: "make it shorter and fresher" produced three stylists matched on
// language alone. If the customer described a style that we could not resolve,
// the honest answer is a clarification, not a ranking on side signals.
if (String(q.style_query ?? '').trim() && !taxonomyId) {
  return JSON.stringify({ ok: true, tool: 'match_stylist', criteria_used: { style_query: String(q.style_query).trim() },
    unknown_taxonomy_id: explicitTax && !knownTax ? explicitTax : null, resolved_style: null, stylists: [],
    clarification_required: true, hint: 'style not recognised; ask the customer for length, layers and fringe' });
}

// --- optional criteria: pass only what the customer stated ------------------
const texture  = String(q.texture ?? '').trim();
const language = String(q.language ?? '').trim();
const rawTier  = q.max_price_tier;
const maxTier  = (rawTier === null || rawTier === undefined || rawTier === '' || !Number.isFinite(Number(rawTier))) ? null : Number(rawTier);

// price tier is a hard filter only; the three real signals sum to 100
const W = { style_specialty: 55, texture_experience: 25, language_match: 20 };

const ranked = snap.rows
  .filter(r => r.active === true && (maxTier === null || Number(r.price_tier) <= maxTier))
  .map(r => {
    let score = 0; const reasons = [];
    if (taxonomyId && arr(r.specialties).includes(taxonomyId)) { score += W.style_specialty; reasons.push('style_specialty'); }
    if (texture && arr(r.hair_experience).includes(texture))   { score += W.texture_experience; reasons.push('texture_experience'); }
    if (language && arr(r.languages).includes(language))       { score += W.language_match; reasons.push('language_match'); }
    return { stylist_id: r.stylist_id, name: r.name, price_tier: r.price_tier, score, reasons, availability_verified: false };
  })
  .filter(r => r.score > 0)
  .sort((a, b) => b.score - a.score || String(a.stylist_id).localeCompare(String(b.stylist_id)))
  .slice(0, 3);

return JSON.stringify({
  ok: true, tool: 'match_stylist',
  criteria_used: { taxonomy_id: taxonomyId || null, texture: texture || null, language: language || null, max_price_tier: maxTier },
  unknown_taxonomy_id: explicitTax && !knownTax ? explicitTax : null,
  resolved_style: resolved,
  weights: W,
  price_tier_is_filter_only: true,
  availability_verified: false,
  stylists: ranked,
  clarification_required: ranked.length === 0
});
