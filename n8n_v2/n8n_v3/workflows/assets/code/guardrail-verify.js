// Guardrail: verify evidence  (stage 4, first half)
//
// Split out of v2's "Validate evidence and render draft", which was one 189-line
// node doing evidence collection AND bilingual rendering AND metrics at once.
// PLAN.md §4/§5 requires the guardrail to be an independent node rather than a
// prompt, so it now stands alone on the canvas and can be reasoned about - and
// tested - on its own. Behaviour is unchanged: see
// scripts/verify_guardrail_split.mjs, which replays the fixtures through both the
// old node and this pair and asserts the emitted envelopes are identical.
//
// This half answers one question only: "is every ID the model referenced backed
// by a SUCCESSFUL tool result from THIS turn?" It writes no prose.

const raw = $input.first().json;
const ctx = $('Normalize and screen input').first().json;

let p = raw.output;
try { if (typeof p === 'string') p = JSON.parse(p); } catch { p = null; }

const errors = [];
const notConfigured = [];
const toolFailures = [];
const toolCalls = [];
const evidence = { services: [], promotions: [], stylists: [], styles: [] };
const steps = raw.intermediateSteps ?? [];

for (const st of steps) {
  if (st && st.action && st.action.tool) toolCalls.push(st.action.tool);
  let o = st ? st.observation : null;
  try {
    for (let d = 0; d < 6; d++) {
      if (typeof o === 'string') { o = JSON.parse(o); continue; }
      if (Array.isArray(o)) { o = o[0]; continue; }
      if (o && o.json) { o = o.json; continue; }
      if (o && o.response) { o = o.response; continue; }
      break;
    }
    if (!o) continue;
    if (o.ok !== true) {
      if (o.error === 'not_configured') notConfigured.push(o.tool);
      else if (['confirmation_required', 'human_required', 'invalid_input'].indexOf(o.error) === -1) toolFailures.push(o.tool + ':' + String(o.error ?? 'unknown'));
      continue;
    }
    if (o.tool === 'service_catalog') evidence.services.push(...(o.services ?? []));
    if (o.tool === 'get_promotions') { evidence.promotions.push(...(o.promotions ?? [])); if (o.resolved_service) evidence.services.push(o.resolved_service); }
    if (o.tool === 'match_stylist') { evidence.stylists.push(...(o.stylists ?? [])); if (o.resolved_style) evidence.styles.push(o.resolved_style); }
    if (o.tool === 'classify_style' && o.confidence >= 0.8 && o.taxonomy_id) {
      evidence.styles.push({ taxonomy_id: o.taxonomy_id, name_en: o.name_en, name_zh: o.name_zh });
    }
  } catch (e) { /* unparseable observation contributes no evidence */ }
}

// repeated identical tool calls must not duplicate draft lines
const uniq = (arr, key) => { const seen = new Set(); return arr.filter(r => { const k = r && r[key]; if (seen.has(k)) return false; seen.add(k); return true; }); };
evidence.services   = uniq(evidence.services, 'service_id');
evidence.promotions = uniq(evidence.promotions, 'promotion_id');
evidence.stylists   = uniq(evidence.stylists, 'stylist_id');
evidence.styles     = uniq(evidence.styles, 'taxonomy_id');

if (!p || typeof p !== 'object') errors.push('invalid_agent_output');
p = p ?? {};

for (const pair of [
  ['service_ids', 'services', 'service_id'],
  ['promotion_ids', 'promotions', 'promotion_id'],
  ['stylist_ids', 'stylists', 'stylist_id']
]) {
  const field = pair[0], key = pair[1], idKey = pair[2];
  if (!Array.isArray(p[field])) { errors.push('invalid_' + field); continue; }
  for (const v of p[field]) if (!evidence[key].some(r => r[idKey] === v)) errors.push('unsupported_' + field);
}
if (p.taxonomy_id && !evidence.styles.some(r => r.taxonomy_id === p.taxonomy_id)) errors.push('unsupported_taxonomy');

const requiredTool = { catalog: 'service_catalog', promotions: 'get_promotions', style: 'classify_style', stylist: 'match_stylist' }[p.intent];
if (requiredTool && toolCalls.indexOf(requiredTool) === -1) errors.push('required_tool_not_called');
if (raw.error) errors.push('agent_failed');

let reason = p.escalate === true ? 'agent_escalation' : (errors.length ? 'guardrail_blocked' : 'shadow_review');
if (toolFailures.length && reason === 'shadow_review') reason = 'tool_failure';
const escalate = p.escalate === true || errors.length > 0 || toolFailures.length > 0;

// A not_configured backend is a known limitation of this draft, not a fault. The
// fact that such a tool was called is the structural signal - it does not depend
// on whatever intent/escalate flag the model happened to choose. Staff see the
// precise limitation instead of a generic "needs review"; nothing claims success.
// Only take over the draft when the model itself framed the turn as booking /
// profile (or escalated). Live run: on "I want a long bob" the model over-called
// the profile tools; a stylist answer must not be hijacked by that detour.
// Live run 3: on "Is the EOFY sale still on?" the model wandered into booking
// stubs and escalated; taking over the draft with booking text was wrong. Only
// the model's own booking/profile intent may trigger the override.
const hitBooking = errors.length === 0 && toolFailures.length === 0 && p.intent === 'booking';
const hitProfile = errors.length === 0 && toolFailures.length === 0 && p.intent === 'profile';
// Live run 3: after get_promotions came back empty for "Is the EOFY sale still
// on?", the model tried every other tool and escalated. Its evidence-backed
// answer ("no verified promotions") is still the right draft; the escalation is
// kept in `reason` for staff. The generic text is reserved for a guardrail
// error, a real tool failure, or an escalation with no substantive intent.
const substantive = ['catalog', 'promotions', 'style', 'stylist'].indexOf(p.intent) !== -1;
const escalateGeneric = errors.length > 0 || toolFailures.length > 0 || (p.escalate === true && !substantive && !hitBooking && !hitProfile);

// The renderer needs the resolved context plus this verdict, nothing else.
return [{ json: {
  ctx,
  parsed: p,
  evidence,
  errors,
  tool_calls: toolCalls,
  not_configured_tools: notConfigured,
  tool_failures: toolFailures,
  reason,
  escalate,
  hit_booking: hitBooking,
  hit_profile: hitProfile,
  escalate_generic: escalateGeneric,
  agent_failed: !!raw.error
} }];

