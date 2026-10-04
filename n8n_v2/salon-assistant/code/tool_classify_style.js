let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'classify_style', error: 'invalid_input' }); }
const conv = $('Conversation state').first().json;
if (conv.forceEscalate) return JSON.stringify({ ok: false, tool: 'classify_style', error: 'human_required' });
const snap = $('Taxonomy snapshot').first().json;
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'classify_style', error: 'catalog_unavailable', retryable: true });

const STOP = 'The style could not be recognised. Do NOT call any other tool. Answer now with intent=clarify, question=style, escalate=false.';
const empty = { ok: true, tool: 'classify_style', taxonomy_id: null, name_en: null, name_zh: null, confidence: 0, clarification_required: true, candidates: [], final_instruction: STOP };

function esc(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Longest matched term wins; Latin terms match on word boundaries so a short
// alias like "lob" cannot fire inside "global". Only a genuine tie clarifies.
function classify(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const matchLen = term => {
    const t = String(term ?? '').trim().toLowerCase();
    if (!t) return 0;
    if (/[㐀-鿿]/.test(t)) return s.includes(t) ? t.length : 0;
    return new RegExp('(^|[^a-z0-9])' + esc(t) + '($|[^a-z0-9])').test(s) ? t.length : 0;
  };
  const scored = snap.rows.map(r => {
    let aliases = [];
    try { const a = JSON.parse(r.aliases || '[]'); if (Array.isArray(a)) aliases = a; } catch {}
    const lens = [r.name_en, r.name_zh, r.taxonomy_id, ...aliases].map(matchLen);
    return { taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh, match_len: Math.max(0, ...lens) };
  }).filter(r => r.match_len > 0)
    .sort((a, b) => b.match_len - a.match_len || String(a.taxonomy_id).localeCompare(String(b.taxonomy_id)));
  if (!scored.length) return null;
  const clearWinner = scored.length === 1 || scored[0].match_len > scored[1].match_len;
  return { scored, clearWinner };
}

// Customer's own words first; the model's rephrasing is a flagged fallback.
let res = classify(conv.chatInput), from = 'customer_text';
if (!res || !res.clearWinner) { const alt = classify(q.text); if (alt && alt.clearWinner) { res = alt; from = 'model_paraphrase'; } }
if (!res) return JSON.stringify(empty);

const top = res.scored[0];
if (!res.clearWinner) return JSON.stringify(Object.assign({}, empty, {
  candidates: res.scored.slice(0, 3).map(r => ({ taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh }))
}));
return JSON.stringify({
  ok: true, tool: 'classify_style',
  taxonomy_id: top.taxonomy_id, name_en: top.name_en, name_zh: top.name_zh,
  confidence: 0.9, clarification_required: false, resolved_from: from,
  candidates: res.scored.slice(0, 3).map(r => ({ taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh }))
});
