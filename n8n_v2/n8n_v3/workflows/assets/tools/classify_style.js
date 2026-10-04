let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'classify_style', error: 'invalid_input' }); }
const snap = $('Taxonomy snapshot').first().json;
if (snap.forceEscalate) return JSON.stringify({ ok: false, tool: 'classify_style', error: 'human_required' });
if (snap.degraded) return JSON.stringify({ ok: false, tool: 'classify_style', error: 'catalog_unavailable', retryable: true });

const s = String(q.text ?? '').trim().toLowerCase();
const empty = { ok: true, tool: 'classify_style', taxonomy_id: null, name_en: null, name_zh: null, confidence: 0, clarification_required: true, candidates: [] };
if (!s) return JSON.stringify(empty);

// FIX P1-3: the old rule was "exactly one row matched, else ask to clarify".
// Any taxonomy with overlapping names ("Bob" / "Long Bob") therefore matched two
// rows and demanded clarification forever. Now: longest matched term wins, and we
// only ask to clarify on a genuine tie. Latin terms match on word boundaries so a
// short alias like "lob" no longer fires inside "global".
function esc(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function matchLen(term) {
  const t = String(term ?? '').trim().toLowerCase();
  if (!t) return 0;
  if (/[㐀-鿿]/.test(t)) return s.includes(t) ? t.length : 0;
  return new RegExp('(^|[^a-z0-9])' + esc(t) + '($|[^a-z0-9])').test(s) ? t.length : 0;
}

const scored = snap.rows.map(r => {
  let aliases = [];
  try { const a = JSON.parse(r.aliases || '[]'); if (Array.isArray(a)) aliases = a; } catch {}
  const lens = [r.name_en, r.name_zh, r.taxonomy_id, ...aliases].map(matchLen);
  return { taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh, match_len: Math.max(0, ...lens) };
}).filter(r => r.match_len > 0)
  .sort((a, b) => b.match_len - a.match_len || String(a.taxonomy_id).localeCompare(String(b.taxonomy_id)));

if (scored.length === 0) return JSON.stringify(empty);
const top = scored[0];
const clearWinner = scored.length === 1 || top.match_len > scored[1].match_len;
return JSON.stringify({
  ok: true, tool: 'classify_style',
  taxonomy_id: clearWinner ? top.taxonomy_id : null,
  name_en: clearWinner ? top.name_en : null,
  name_zh: clearWinner ? top.name_zh : null,
  confidence: clearWinner ? 0.9 : 0,
  clarification_required: !clearWinner,
  candidates: scored.slice(0, 3).map(r => ({ taxonomy_id: r.taxonomy_id, name_en: r.name_en, name_zh: r.name_zh }))
});
