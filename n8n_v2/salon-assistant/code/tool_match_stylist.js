let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'match_stylist', error: 'invalid_input' }); }
const conv = $('Conversation state').first().json;
if (conv.forceEscalate) return JSON.stringify({ ok: false, tool: 'match_stylist', error: 'human_required' });
const snap = $('Stylists snapshot').first().json;
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'match_stylist', error: 'catalog_unavailable', retryable: true });

const arr = x => { try { const a = JSON.parse(x || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const taxRows = ($('Taxonomy snapshot').first().json.rows || []);

function esc(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function resolveStyle(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const matchLen = term => {
    const t = String(term ?? '').trim().toLowerCase();
    if (!t) return 0;
    if (/[㐀-鿿]/.test(t)) return s.includes(t) ? t.length : 0;
    return new RegExp('(^|[^a-z0-9])' + esc(t) + '($|[^a-z0-9])').test(s) ? t.length : 0;
  };
  const scored = taxRows.map(r => {
    const lens = [r.name_en, r.name_zh, r.taxonomy_id, ...arr(r.aliases)].map(matchLen);
    return { r, len: Math.max(0, ...lens) };
  }).filter(x => x.len > 0).sort((a, b) => b.len - a.len || String(a.r.taxonomy_id).localeCompare(String(b.r.taxonomy_id)));
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].len === scored[1].len) return null;  // genuine tie: do not guess
  const r = scored[0].r;
  return { taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh };
}

// Priority: verified id > confirmed slot > customer's own words > model paraphrase.
const explicitTax = String(q.taxonomy_id ?? '').trim();
const knownTax = !!explicitTax && taxRows.some(r => r.taxonomy_id === explicitTax);
const slotTax = conv.slots && conv.slots.style && conv.slots.style.taxonomy_id;
let resolved = null, resolvedFrom = null;
if (!knownTax) {
  if (slotTax && taxRows.some(r => r.taxonomy_id === slotTax)) {
    const r = taxRows.find(x => x.taxonomy_id === slotTax);
    resolved = { taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh };
    resolvedFrom = 'confirmed_slot';
  } else {
    resolved = resolveStyle(conv.chatInput);
    if (resolved) resolvedFrom = 'customer_text';
    else { resolved = resolveStyle(q.style_query); if (resolved) resolvedFrom = 'model_paraphrase'; }
  }
}
const taxonomyId = knownTax ? explicitTax : (resolved ? resolved.taxonomy_id : '');

// A style the customer described but we could not recognise must not be turned
// into a ranking on side signals (live run: "shorter and fresher" produced three
// stylists matched on language alone).
if (String(q.style_query ?? '').trim() && !taxonomyId) {
  return JSON.stringify({ ok: true, tool: 'match_stylist', criteria_used: { style_query: String(q.style_query).trim() },
    unknown_taxonomy_id: explicitTax && !knownTax ? explicitTax : null, resolved_style: null, stylists: [],
    clarification_required: true, hint: 'style not recognised; ask the customer for length, layers and fringe',
    final_instruction: 'The style could not be recognised. Do NOT call any other tool. Answer now with intent=clarify, question=style, escalate=false.' });
}

const texture  = String(q.texture ?? '').trim();
const language = String(q.language ?? '').trim() || (conv.language === 'zh' ? 'zh' : 'en');
const rawTier  = q.max_price_tier;
const maxTier  = (rawTier === null || rawTier === undefined || rawTier === '' || !Number.isFinite(Number(rawTier))) ? null : Number(rawTier);

// price tier is a hard filter only; the three real signals sum to 100
const W = { style_specialty: 55, texture_experience: 25, language_match: 20 };

const scoredAll = snap.rows
  .filter(r => r.active === true && (maxTier === null || Number(r.price_tier) <= maxTier))
  .map(r => {
    let score = 0; const reasons = [];
    if (taxonomyId && arr(r.specialties).includes(taxonomyId)) { score += W.style_specialty; reasons.push('style_specialty'); }
    if (texture && arr(r.hair_experience).includes(texture))   { score += W.texture_experience; reasons.push('texture_experience'); }
    if (language && arr(r.languages).includes(language))       { score += W.language_match; reasons.push('language_match'); }
    return { stylist_id: r.stylist_id, name: r.name, price_tier: r.price_tier, score, reasons, availability_verified: false };
  })
  .filter(r => r.score > 0)
  .sort((a, b) => b.score - a.score || String(a.stylist_id).localeCompare(String(b.stylist_id)));

// If anyone actually specialises in the requested style, only they are offered.
// Listing a non-specialist third (live run: "Jayden Wu - language match" under
// two balayage specialists) reads as a recommendation and is misleading.
const specialists = scoredAll.filter(r => r.reasons.indexOf('style_specialty') !== -1);
const ranked = (taxonomyId && specialists.length ? specialists : scoredAll).slice(0, 3);

return JSON.stringify({
  ok: true, tool: 'match_stylist',
  criteria_used: { taxonomy_id: taxonomyId || null, texture: texture || null, language: language || null, max_price_tier: maxTier },
  unknown_taxonomy_id: explicitTax && !knownTax ? explicitTax : null,
  resolved_style: resolved,
  resolved_from: resolvedFrom,
  weights: W,
  price_tier_is_filter_only: true,
  availability_verified: false,
  stylists: ranked,
  clarification_required: ranked.length === 0,
  ...(ranked.length === 0
    ? { final_instruction: 'No stylist matches these criteria. This result is final. Do NOT call any other tool. Answer now with intent=stylist, stylist_ids=[], escalate=false.' }
    : (taxonomyId && !ranked.some(r => r.reasons.indexOf('style_specialty') !== -1))
      ? { note: 'no_specialist_for_style', final_instruction: 'No stylist lists this style as a specialty; the stylists above match only on other criteria. This result is final. Do NOT call any other tool. Answer now with intent=stylist and the stylist_ids above, escalate=false.' }
      : {})
});
