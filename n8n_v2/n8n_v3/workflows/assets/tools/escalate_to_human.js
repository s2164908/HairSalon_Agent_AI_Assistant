let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { q = {}; }
return JSON.stringify({
  ok: true, tool: 'escalate_to_human',
  requires_human: true,
  status: 'review_required',
  reason: String(q.reason ?? 'unspecified').slice(0, 80)
});
