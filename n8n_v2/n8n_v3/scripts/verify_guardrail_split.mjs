#!/usr/bin/env node
// Behaviour-equivalence test for the guardrail split.
//
// The most dangerous part of the v3 refactor is that v2's "Validate evidence and
// render draft" (one 189-line node) became two nodes: "Guardrail: verify evidence"
// and "Render draft". A transcription slip there would change what a draft says,
// and nothing else in the workflow would complain - the guardrail would simply
// start passing things it used to block, or drop a price line.
//
// This harness removes that risk. It compiles the ORIGINAL v2 node body straight
// out of workflows/assets/code/_v2-validate-reference.js, compiles the v3 pair,
// replays the same fixtures through both and deep-compares the emitted envelopes.
//
// Run:  node scripts/verify_guardrail_split.mjs
// Exit 0 = the pair is behaviourally identical to the node it replaced.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = join(ROOT, 'workflows', 'assets', 'code');
const read = (f) => readFileSync(join(CODE, f), 'utf8');

/** Compile an n8n Code-node body (top-level `return`) into a callable. */
function compile(code, name) {
  try {
    return new Function('$input', '$', code);
  } catch (e) {
    throw new Error(`${name} does not compile: ${e.message}`);
  }
}

/** n8n hands Code nodes `$('Node name').first().json`. Accept both spellings so
 *  the same fixture can drive the v2 node and the renamed v3 pair. */
const accessor = (ctx) => (nodeName) => {
  if (nodeName === 'Normalize input' || nodeName === 'Normalize and screen input') {
    return { first: () => ({ json: ctx }) };
  }
  throw new Error(`unexpected $('${nodeName}') reference`);
};

const v2Combined = compile(read('_v2-validate-reference.js'), 'v2 validate node');
const v3Guardrail = compile(read('guardrail-verify.js'), 'guardrail-verify.js');
const v3Render = compile(read('render-draft.js'), 'render-draft.js');

const runV2 = (agent, ctx) =>
  v2Combined({ first: () => ({ json: agent }) }, accessor(ctx))[0].json;

const runV3 = (agent, ctx) => {
  const guard = v3Guardrail({ first: () => ({ json: agent }) }, accessor(ctx))[0].json;
  return v3Render({ first: () => ({ json: guard }) }, accessor(ctx))[0].json;
};

// ---------------------------------------------------------------- fixtures ---
const step = (tool, observation) => ({ action: { tool }, observation });
const EN = { chatInput: 'How much is a men\u2019s cut?', sessionId: 's1', language: 'en', truncated: false };
const ZH = { chatInput: '\u5973\u58eb\u526a\u53d1\u591a\u5c11\u94b1\uff1f', sessionId: 's2', language: 'zh', truncated: false };

const SERVICES = [
  { service_id: 'svc_cut_men', name: "Men's Cut", name_zh: '\u7537\u58eb\u526a\u53d1', price: 45, currency: 'AUD', duration_min: 30 },
  { service_id: 'svc_cut_women', name: 'Ladies Cut & Style', name_zh: '\u5973\u58eb\u526a\u53d1\u9020\u578b', price: 85, currency: 'AUD', duration_min: 60 },
];
const PROMOS = [{ promotion_id: 'promo_open_all', title: 'Spring Refresh - 10% off any service' }];
const STYLISTS = [
  { stylist_id: 'sty_amy', name: 'Amy Chen', reasons: ['style_specialty', 'language_match'] },
  { stylist_id: 'sty_priya', name: 'Priya Raman', reasons: ['texture_experience'] },
];
const tool = (toolName, extra) => JSON.stringify({ ok: true, tool: toolName, ...extra });

const agent = (output, steps = [], error = undefined) => ({ output, intermediateSteps: steps, error });
const out = (o) => ({ service_ids: [], promotion_ids: [], stylist_ids: [], taxonomy_id: null, question: 'none', escalate: false, ...o });

const fixtures = [
  { name: 'catalog: single service price (en)', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: ['svc_cut_men'] }),
      [step('service_catalog', tool('service_catalog', { services: SERVICES }))]) },

  { name: 'catalog: empty catalogue', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: [] }),
      [step('service_catalog', tool('service_catalog', { services: [] }))]) },

  { name: 'promotions: none eligible (empty is a valid answer)', ctx: EN,
    agent: agent(out({ intent: 'promotions' }),
      [step('get_promotions', tool('get_promotions', { promotions: [] }))]) },

  { name: 'promotions: eligible + resolved_service folded into evidence', ctx: EN,
    agent: agent(out({ intent: 'promotions', service_ids: ['svc_cut_men'], promotion_ids: ['promo_open_all'] }),
      [step('get_promotions', tool('get_promotions', { promotions: PROMOS, resolved_service: SERVICES[0] }))]) },

  { name: 'style: high-confidence taxonomy match', ctx: EN,
    agent: agent(out({ intent: 'style', taxonomy_id: 'sty_layered_lob' }),
      [step('classify_style', tool('classify_style', { taxonomy_id: 'sty_layered_lob', name_en: 'Layered Lob', name_zh: '\u9f50\u80a9\u5c42\u6b21\u53d1', confidence: 0.9 }))]) },

  { name: 'style: LOW confidence must not become evidence', ctx: EN,
    agent: agent(out({ intent: 'style', taxonomy_id: 'sty_layered_lob' }),
      [step('classify_style', tool('classify_style', { taxonomy_id: 'sty_layered_lob', name_en: 'Layered Lob', name_zh: '\u9f50\u80a9\u5c42\u6b21\u53d1', confidence: 0.4 }))]) },

  { name: 'style: clarification fallback', ctx: EN,
    agent: agent(out({ intent: 'style' }),
      [step('classify_style', tool('classify_style', { taxonomy_id: null, confidence: 0, clarification_required: true }))]) },

  { name: 'stylist: ranking + resolved_style + reasons', ctx: EN,
    agent: agent(out({ intent: 'stylist', stylist_ids: ['sty_amy', 'sty_priya'] }),
      [step('match_stylist', tool('match_stylist', { stylists: STYLISTS, resolved_style: { taxonomy_id: 'sty_balayage', name_en: 'Balayage', name_zh: '\u624b\u7ed8\u6311\u67d3' } }))]) },

  { name: 'stylist: none matched', ctx: EN,
    agent: agent(out({ intent: 'stylist' }),
      [step('match_stylist', tool('match_stylist', { stylists: [] }))]) },

  { name: 'GUARDRAIL: invented service id is blocked', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: ['svc_cut'] }),
      [step('service_catalog', tool('service_catalog', { services: SERVICES }))]) },

  { name: 'GUARDRAIL: missing id array', ctx: EN,
    agent: agent({ intent: 'catalog', promotion_ids: [], stylist_ids: [], taxonomy_id: null, question: 'none', escalate: false },
      [step('service_catalog', tool('service_catalog', { services: SERVICES }))]) },

  { name: 'GUARDRAIL: required tool never called', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: [] }), []) },

  { name: 'GUARDRAIL: unparseable agent output', ctx: EN,
    agent: agent('not json at all', []) },

  { name: 'GUARDRAIL: agent failed', ctx: EN,
    agent: agent(undefined, [], 'max iterations exceeded') },

  { name: 'FAILURE: not_configured -> booking override', ctx: EN,
    agent: agent(out({ intent: 'booking' }),
      [step('find_slots', JSON.stringify({ ok: false, tool: 'find_slots', error: 'not_configured' }))]) },

  { name: 'FAILURE: confirmation_required -> profile override', ctx: EN,
    agent: agent(out({ intent: 'profile' }),
      [step('hair_profile_write', JSON.stringify({ ok: false, tool: 'hair_profile_write', error: 'confirmation_required' }))]) },

  { name: 'FAILURE: real tool error -> escalate', ctx: EN,
    agent: agent(out({ intent: 'promotions' }),
      [step('get_promotions', JSON.stringify({ ok: false, tool: 'get_promotions', error: 'catalog_unavailable' }))]) },

  { name: 'ESCALATE with no substantive intent -> generic text', ctx: EN,
    agent: agent(out({ intent: 'escalation', escalate: true }),
      [step('escalate_to_human', tool('escalate_to_human', {}))]) },

  { name: 'ESCALATE but substantive evidence is kept', ctx: EN,
    agent: agent(out({ intent: 'promotions', escalate: true }),
      [step('get_promotions', tool('get_promotions', { promotions: [] }))]) },

  { name: 'CLARIFY: question=style', ctx: EN,
    agent: agent(out({ intent: 'clarify', question: 'style' }), []) },

  { name: 'GREETING: question=none', ctx: EN,
    agent: agent(out({ intent: 'greeting' }), []) },

  { name: 'DUPLICATES: repeated tool calls are de-duplicated', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: ['svc_cut_men'] }),
      [step('service_catalog', tool('service_catalog', { services: SERVICES })),
       step('service_catalog', tool('service_catalog', { services: SERVICES }))]) },

  { name: 'SANITISE: control chars and DEL in a table value', ctx: EN,
    agent: agent(out({ intent: 'promotions', promotion_ids: ['promo_open_all'] }),
      [step('get_promotions', tool('get_promotions', { promotions: [{ promotion_id: 'promo_open_all', title: 'Spring\u0000Refresh\u001f-\u007f10% off' }] }))]) },

  { name: 'TRUNCATED input note is appended', ctx: { ...EN, truncated: true },
    agent: agent(out({ intent: 'greeting' }), []) },

  { name: 'zh: catalog price line', ctx: ZH,
    agent: agent(out({ intent: 'catalog', service_ids: ['svc_cut_women'] }),
      [step('service_catalog', tool('service_catalog', { services: SERVICES }))]) },

  { name: 'zh: stylist list', ctx: ZH,
    agent: agent(out({ intent: 'stylist', stylist_ids: ['sty_amy'] }),
      [step('match_stylist', tool('match_stylist', { stylists: STYLISTS }))]) },

  { name: 'zh: style match', ctx: ZH,
    agent: agent(out({ intent: 'style', taxonomy_id: 'sty_blunt_bob' }),
      [step('classify_style', tool('classify_style', { taxonomy_id: 'sty_blunt_bob', name_en: 'Blunt Bob', name_zh: '\u9f50\u9888\u6ce2\u6ce2\u5934', confidence: 0.95 }))]) },

  { name: 'OBSERVATION SHAPES: nested array/json/response wrappers', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: ['svc_cut_men'] }),
      [step('service_catalog', [{ json: { response: tool('service_catalog', { services: SERVICES }) } }])]) },

  { name: 'OBSERVATION: unparseable contributes no evidence', ctx: EN,
    agent: agent(out({ intent: 'catalog', service_ids: ['svc_cut_men'] }),
      [step('service_catalog', '{{{ not json')]) },
];

// ------------------------------------------------------------------- runner ---
let identical = 0;
const mismatches = [];

for (const f of fixtures) {
  let v2;
  let v3;
  let v2err;
  let v3err;
  try { v2 = runV2(f.agent, f.ctx); } catch (e) { v2err = e; }
  try { v3 = runV3(f.agent, f.ctx); } catch (e) { v3err = e; }

  if (v2err ?? v3err) {
    if (String(v2err) === String(v3err)) { identical += 1; continue; }
    mismatches.push(`${f.name}\n  v2 threw: ${v2err}\n  v3 threw: ${v3err}`);
    continue;
  }

  if (process.env.VERBOSE) {
    const shown = v2err ? `<threw ${v2err}>` : JSON.stringify(v2.draft_reply);
    console.log(`  [${f.name}] v2.draft_reply = ${shown}`);
  }

  if (JSON.stringify(v2) === JSON.stringify(v3)) { identical += 1; continue; }
  const keys = new Set([...Object.keys(v2), ...Object.keys(v3)]);
  const diffs = [];
  for (const k of keys) {
    const a = JSON.stringify(v2[k]);
    const b = JSON.stringify(v3[k]);
    if (a !== b) diffs.push(`  ${k}:\n    v2 = ${a}\n    v3 = ${b}`);
  }
  mismatches.push(`${f.name}\n${diffs.join('\n')}`);
}

console.log(`guardrail split equivalence: ${identical}/${fixtures.length} fixtures identical`);
if (mismatches.length) {
  console.log('\nMISMATCHES (v2 combined node vs v3 guardrail+render pair):\n');
  for (const m of mismatches) console.log(m + '\n');
  process.exitCode = 1;
} else {
  console.log('OK - the v3 pair is behaviourally identical to the node it replaced.');
  console.log('(covers price rendering, promo/style/stylist branches, hallucination blocking,');
  console.log(' not_configured overrides, escalation, sanitisation, zh rendering, truncation)');
}


