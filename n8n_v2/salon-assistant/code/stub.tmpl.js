// FIX P1-4: distinct code so the agent can tell "this draft has not wired up the
// backend yet" (expected, escalate=false, renderer explains it) apart from
// "a configured tool just failed" (unexpected, escalate=true).
return JSON.stringify({ ok: false, tool: '__NAME__', error: 'not_configured', configured: false, detail: '__DETAIL__' });
