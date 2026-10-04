let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); } catch { q = {}; }
// Structural gate (PLAN.md section 5). Live run: on "I want a long bob" the model
// called this tool with texture "wavy" - a value the customer never said. A
// profile write without an explicit confirmation is refused before any backend
// is consulted, so the gate is observable now and enforced once writes go live.
if (q.customer_confirmed !== true || !String(q.confirmed_utterance ?? '').trim()) {
  return JSON.stringify({ ok: false, tool: 'hair_profile_write', error: 'confirmation_required', saved: false,
    detail: 'ask the customer to confirm the exact values and storage consent first; pass customer_confirmed=true and their confirming words' });
}
return JSON.stringify({ ok: false, tool: 'hair_profile_write', error: 'not_configured', configured: false, saved: false,
  detail: 'verified identity and consent flow are not connected in this draft' });
