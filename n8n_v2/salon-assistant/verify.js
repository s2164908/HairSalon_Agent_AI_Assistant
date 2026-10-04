// Logic-level checks: each node's jsCode is pulled out of the BUILT workflow and
// run under `new Function` with a stubbed n8n runtime. Proves logic, not n8n
// integration — run_conversations.js is the integration check.
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'salon-assistant-v2.json'), 'utf8'));
const node = n => wf.nodes.find(x => x.name === n);
const toolCode = n => node(n).parameters.jsCode;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

// --- fixtures ---------------------------------------------------------------
const ctx = { chatInput: 'test', sessionId: 's1', language: 'en', forceEscalate: false, truncated: false, slots: {} };

const services = [
  { service_id: 'svc_cut_women', name: "Women's Cut", name_zh: '女士剪发', active: true, price: 85, currency: 'AUD', duration_min: 60, allowed_stylist_levels: '["junior","senior","director"]' },
  { service_id: 'svc_cut_men', name: "Men's Cut", name_zh: '男士剪发', active: true, price: 45, currency: 'AUD', duration_min: 30, allowed_stylist_levels: '["junior","senior","director"]' },
  { service_id: 'svc_balayage', name: 'Balayage', name_zh: '手绘挑染', active: true, price: 320, currency: 'AUD', duration_min: 180, allowed_stylist_levels: '["senior","director"]' },
  { service_id: 'svc_retired', name: 'Retired', active: false, price: 10, currency: 'AUD', duration_min: 10, allowed_stylist_levels: '[]' }
];
const stylists = [
  { stylist_id: 'stl_amy', name: 'Amy', active: true, price_tier: 2, specialties: '["sty_blunt_bob"]', hair_experience: '["straight"]', languages: '["en","zh"]' },
  { stylist_id: 'stl_marco', name: 'Marco', active: true, price_tier: 3, specialties: '["sty_blunt_bob","sty_wolf_cut"]', hair_experience: '["straight","curly"]', languages: '["en"]' },
  { stylist_id: 'stl_jayden', name: 'Jayden', active: true, price_tier: 1, specialties: '[]', hair_experience: '["straight"]', languages: '["en"]' }
];
const taxonomy = [
  { taxonomy_id: 'sty_blunt_bob', name_en: 'Blunt Bob', name_zh: '齐颈波波头', aliases: '["bob"]' },
  { taxonomy_id: 'sty_long_bob', name_en: 'Long Bob', name_zh: '长波波头', aliases: '["lob"]' },
  { taxonomy_id: 'sty_wolf_cut', name_en: 'Wolf Cut', name_zh: '狼尾头', aliases: '[]' }
];
const promotions = [
  { promotion_id: 'promo_open', title: 'Spring 10% off', active: true, valid_from: '2026-01-01', valid_to: '2099-12-31',
    channels: '["web"]', eligibility: '{"everyone":true}', discount: '{"type":"percent","value":10}' },
  { promotion_id: 'promo_expired', title: 'EOFY sale', active: true, valid_from: '2026-05-15', valid_to: '2026-06-30',
    channels: '["web"]', eligibility: '{"everyone":true}', discount: '{"type":"percent","value":25}' }
];

// Availability fixtures are built relative to now so the suite never rots.
const TZ = 'Australia/Sydney';
const dayIso = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const soon = new Date(Date.now() + 3 * 86400000);          // 3 days out, always future
const soonIso = dayIso(soon);
const soonWeekday = new Date(soonIso + 'T00:00:00Z').getUTCDay();
const schedule = [
  { stylist_id: 'stl_amy', weekday: soonWeekday, start_time: '09:00', end_time: '17:00', valid_from: '2020-01-01', valid_to: '2099-12-31' },
  { stylist_id: 'stl_jayden', weekday: soonWeekday, start_time: '10:00', end_time: '12:00', valid_from: '2020-01-01', valid_to: '2099-12-31' }
];
const appointments = [
  // blocks Amy 09:00-13:00 local
  { appointment_id: 'a1', stylist_id: 'stl_amy', service_id: 'svc_cut_women', status: 'confirmed',
    start: soonIso + 'T09:00:00+10:00', end: soonIso + 'T13:00:00+10:00' },
  // cancelled must NOT block Jayden
  { appointment_id: 'a2', stylist_id: 'stl_jayden', service_id: 'svc_cut_men', status: 'cancelled',
    start: soonIso + 'T10:00:00+10:00', end: soonIso + 'T12:00:00+10:00' }
];

function snapsWith(overrides) {
  const base = {
    'Conversation state': { ...ctx },
    'Services snapshot':     { ...ctx, rows: services, degraded: false },
    'Stylists snapshot':     { ...ctx, rows: stylists, degraded: false },
    'Taxonomy snapshot':     { ...ctx, rows: taxonomy, degraded: false },
    'Promotions snapshot':   { ...ctx, rows: promotions, degraded: false },
    'Schedule snapshot':     { ...ctx, rows: schedule, degraded: false },
    'Appointments snapshot': { ...ctx, rows: appointments, degraded: false }
  };
  return Object.assign(base, overrides || {});
}
const snaps = snapsWith();
function runTool(nodeName, query, s) {
  const store = s || snaps;
  const $ = name => ({ first: () => ({ json: store[name] }) });
  return JSON.parse(new Function('query', '$', toolCode(nodeName))(JSON.stringify(query), $));
}
// conv overrides let a test pretend earlier turns already confirmed something
const withConv = extra => snapsWith({ 'Conversation state': { ...ctx, ...extra } });

console.log('\n=== service_catalog ===');
let r = runTool('service_catalog', {}, snaps);
check('no filter -> all active services', r.ok && r.services.length === 3, r.services && r.services.length);
check('inactive excluded', !r.services.some(s => s.service_id === 'svc_retired'));
r = runTool('service_catalog', { service_id: 'svc_invented' }, snaps);
check('unknown id flagged', r.unknown_service_id === true, r);
r = runTool('service_catalog', { service_query: "men's cut" }, withConv({ chatInput: "how much is a men's cut?" }));
check('resolves from the customer text, marked customer_text', r.filtered_by_service_id === 'svc_cut_men' && r.resolved_from === 'customer_text', r);
r = runTool('service_catalog', { service_query: 'balayage' }, withConv({ chatInput: 'something fresh for spring' }));
check('paraphrase-only match is flagged model_paraphrase', r.filtered_by_service_id === 'svc_balayage' && r.resolved_from === 'model_paraphrase', r);

console.log('\n=== get_promotions ===');
r = runTool('get_promotions', {}, snaps);
check('live promo returned, expired excluded', r.promotions.map(p => p.promotion_id).join() === 'promo_open', r.promotions);
check('discount travels with the row', !!r.promotions[0].discount, r.promotions[0]);
r = runTool('get_promotions', {}, snapsWith({ 'Promotions snapshot': { ...ctx, rows: [promotions[1]], degraded: false } }));
check('empty -> NO_PROMOTIONS + stop instruction', r.promotions.length === 0 && r.result === 'NO_PROMOTIONS' && /Do NOT call/.test(r.final_instruction), r);
r = runTool('get_promotions', {}, withConv({ slots: { service: { id: 'svc_cut_men' } } }));
check('confirmed slot resolves the service without re-asking', r.filtered_by_service_id === 'svc_cut_men' && r.resolved_from === 'confirmed_slot', r);

console.log('\n=== classify_style ===');
for (const [text, expect] of [['I want a long bob', 'sty_long_bob'], ['just a bob please', 'sty_blunt_bob'], ['长波波头', 'sty_long_bob']]) {
  const c = runTool('classify_style', { text }, withConv({ chatInput: text }));
  check('"' + text + '" -> ' + expect, c.taxonomy_id === expect && c.resolved_from === 'customer_text', c);
}
let c = runTool('classify_style', { text: 'make it shorter' }, withConv({ chatInput: 'make it shorter' }));
check('vague -> clarification + stop instruction', c.taxonomy_id === null && /intent=clarify/.test(c.final_instruction), c);
c = runTool('classify_style', { text: 'a global brand' }, withConv({ chatInput: 'a global brand' }));
check('short alias "lob" does not fire inside "global"', c.taxonomy_id === null, c);
c = runTool('classify_style', { text: 'wolf cut' }, withConv({ chatInput: 'something edgy and layered' }));
check('paraphrase-only style flagged model_paraphrase', c.taxonomy_id === 'sty_wolf_cut' && c.resolved_from === 'model_paraphrase', c);

console.log('\n=== match_stylist ===');
r = runTool('match_stylist', { taxonomy_id: 'sty_blunt_bob' }, snaps);
check('only specialists are offered when specialists exist', r.stylists.map(s => s.stylist_id).sort().join() === 'stl_amy,stl_marco', r.stylists);
check('price_tier is filter-only', r.price_tier_is_filter_only === true && !r.stylists.some(s => s.reasons.includes('price_tier_match')));
r = runTool('match_stylist', { taxonomy_id: 'sty_long_bob' }, snaps);
check('nobody specialises -> fall back to side signals, flagged', r.stylists.length > 0 && r.note === 'no_specialist_for_style' && /Do NOT call/.test(r.final_instruction), r);
r = runTool('match_stylist', { style_query: 'shorter and fresher' }, withConv({ chatInput: 'shorter and fresher' }));
check('unresolved style -> clarification, no side-signal ranking', r.stylists.length === 0 && /intent=clarify/.test(r.final_instruction), r);
r = runTool('match_stylist', {}, withConv({ slots: { style: { taxonomy_id: 'sty_wolf_cut' } } }));
check('confirmed style slot drives the ranking', r.criteria_used.taxonomy_id === 'sty_wolf_cut' && r.resolved_from === 'confirmed_slot' && r.stylists[0].stylist_id === 'stl_marco', r);

console.log('\n=== find_slots (read-only availability) ===');
r = runTool('find_slots', { date_from: soonIso, date_to: soonIso }, withConv({ slots: { service: { id: 'svc_cut_men' } } }));
check('returns real slots, never reserved', r.ok && r.slots.length > 0 && r.reserved === false && r.slots.every(s => s.reserved === false), r.slots && r.slots.length);
check('reply instruction says the times are not held', /NOT reserved/.test(r.final_instruction), r.final_instruction);
const amySlots = r.slots.filter(s => s.stylist_id === 'stl_amy');
check('Amy is not offered inside her 09:00-13:00 booking',
  amySlots.every(s => Date.parse(s.start) >= Date.parse(soonIso + 'T13:00:00+10:00')), amySlots.map(s => s.label));
check('a cancelled appointment does not block Jayden', r.slots.some(s => s.stylist_id === 'stl_jayden'), r.slots.map(s => s.stylist_name));
r = runTool('find_slots', { date_from: soonIso, date_to: soonIso, day_part: 'morning' }, withConv({ slots: { service: { id: 'svc_cut_men' } } }));
check('day_part=morning keeps only pre-noon starts',
  r.slots.every(s => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(s.start))) < 12), r.slots.map(s => s.label));
r = runTool('find_slots', {}, snaps);
check('no service yet -> SERVICE_REQUIRED, does not guess', r.result === 'SERVICE_REQUIRED' && r.slots.length === 0, r);
r = runTool('find_slots', { date_from: soonIso, date_to: soonIso }, withConv({ slots: { service: { id: 'svc_balayage' } } }));
check('service only seniors can do excludes junior-only shifts', !r.slots.some(s => s.stylist_id === 'stl_jayden'), r.slots);
const noShiftIso = dayIso(new Date(Date.parse(soonIso + 'T00:00:00Z') + 86400000)); // next day: no roster row in the fixture
r = runTool('find_slots', { date_from: noShiftIso, date_to: noShiftIso }, withConv({ slots: { service: { id: 'svc_cut_men' } } }));
check('no availability -> NO_AVAILABILITY + stop instruction', r.slots.length === 0 && r.result === 'NO_AVAILABILITY' && /Do NOT call/.test(r.final_instruction), r);

console.log('\n=== stubs and gates ===');
for (const t of ['hair_profile_read', 'hold_slot', 'confirm_booking', 'cancel_reschedule']) {
  const s = runTool(t, {}, snaps);
  check(t + ' -> not_configured', s.ok === false && s.error === 'not_configured', s);
}
r = runTool('hair_profile_write', { texture: 'wavy' }, snaps);
check('profile write without confirmation -> confirmation_required', r.error === 'confirmation_required', r);
r = runTool('hair_profile_write', { texture: 'wavy', customer_confirmed: true, confirmed_utterance: 'yes, wavy' }, snaps);
check('profile write with confirmation -> not_configured (backend stub)', r.error === 'not_configured', r);

console.log('\n=== degradation ===');
const snapFn = new Function('$input', '$', node('Services snapshot').parameters.jsCode);
const $in = rows => ({ all: () => rows.map(json => ({ json })) });
const $conv = () => ({ first: () => ({ json: ctx }) });
let out = snapFn($in([{ error: 'db down' }]), $conv);
check('Data Table failure -> degraded, no throw', out[0].json.degraded === true && out[0].json.rows.length === 0, out[0].json);
out = snapFn($in([{}]), $conv);
check('empty table -> rows [] and degraded false', out[0].json.degraded === false && out[0].json.rows.length === 0);
r = runTool('service_catalog', {}, snapsWith({ 'Services snapshot': { ...ctx, rows: [], degraded: true } }));
check('degraded catalogue -> catalog_unavailable', r.ok === false && r.error === 'catalog_unavailable', r);

console.log('\n=== conversation state node ===');
const convFn = (items, c) => new Function('$input', '$', node('Conversation state').parameters.jsCode)(
  { all: () => items.map(json => ({ json })) },
  () => ({ first: () => ({ json: c }) })
)[0].json;
let cs = convFn([], { ...ctx, chatInput: 'hi' });
check('first turn -> empty slots, everything missing', Object.keys(cs.slots).length === 0 && cs.slotsMissing.length === 5 && cs.turnCount === 0, cs.slotsMissing);
const storedSlots = { service: { id: 'svc_cut_men', name: "Men's Cut", price: 45, currency: 'AUD', duration_min: 30 }, style: { taxonomy_id: 'sty_blunt_bob', name_en: 'Blunt Bob' } };
cs = convFn([{ session_id: 's1', status: 'gathering', slots: JSON.stringify(storedSlots), recent_turns: '["a bob"]', last_question: 'time_window', turn_count: 2, updated_at: new Date().toISOString() }], { ...ctx, chatInput: 'wednesday' });
check('stored slots are restored', cs.slots.service.id === 'svc_cut_men' && cs.turnCount === 2, cs.slots);
check('missing excludes what is confirmed', cs.slotsMissing.join() === 'time_window,stylist,time_slot', cs.slotsMissing);
check('prompt tells the model today\'s date', /\[TODAY\]/.test(cs.agentPrompt) && /Australia\/Sydney/.test(cs.agentPrompt), cs.agentPrompt.slice(-200));
check('prompt carries confirmed IDs and the last question', /service_id=svc_cut_men/.test(cs.agentPrompt) && /WE ASKED LAST TURN/.test(cs.agentPrompt) && /wednesday/.test(cs.agentPrompt), cs.agentPrompt.slice(0, 200));
cs = convFn([{ session_id: 'OTHER', slots: JSON.stringify(storedSlots), updated_at: new Date().toISOString() }], { ...ctx, chatInput: 'hi' });
check('another session\'s row is never adopted', Object.keys(cs.slots).length === 0, cs.slots);
cs = convFn([{ session_id: 's1', slots: JSON.stringify(storedSlots), updated_at: new Date(Date.now() - 36 * 3600000).toISOString() }], { ...ctx, chatInput: 'hi' });
check('state older than 24h is dropped', cs.stateStale === true && Object.keys(cs.slots).length === 0, cs.stateStale);
cs = convFn([{ session_id: 's1', slots: JSON.stringify(storedSlots), updated_at: new Date().toISOString() }], { ...ctx, chatInput: '重新开始' });
check('customer can reset', cs.resetRequested === true && Object.keys(cs.slots).length === 0);
cs = convFn([{ error: 'table offline' }], { ...ctx, chatInput: 'hi' });
check('state table failure degrades to empty, no throw', cs.convDegraded === true && Object.keys(cs.slots).length === 0);

console.log('\n=== workflow wiring and node config ===');
for (const n of ['Read Services', 'Read Promotions', 'Read Stylists', 'Read Taxonomy', 'Read Schedule',
                 'Read Appointments', 'Load conversation state', 'Upsert conversation state', 'Queue for staff review'])
  check(n + ' degrades instead of crashing', node(n).onError === 'continueRegularOutput');
check('no memory sub-node remains', !wf.nodes.some(n => /memory/i.test(n.type)), wf.nodes.filter(n => /memory/i.test(n.type)).map(n => n.name));
check('agent retries transient failures', node('Salon Tools Agent').retryOnFail === true && node('Salon Tools Agent').maxTries === 3);
check('parallel tool calls disabled', /parallel_tool_calls/.test(node('Replaceable chat model').parameters.options.extraBody));
check('workflow has a 120s execution timeout', wf.settings.executionTimeout === 120);
check('agent prompt comes from Conversation state', /Conversation state/.test(node('Salon Tools Agent').parameters.text));
check('state is loaded before the risk screen',
  wf.connections['Normalize and screen input'].main[0][0].node === 'Load conversation state' &&
  wf.connections['Conversation state'].main[0][0].node === 'Risk screen');
check('conversation upsert matches on session_id',
  node('Upsert conversation state').parameters.filters.conditions[0].keyName === 'session_id' &&
  node('Upsert conversation state').parameters.operation === 'upsert');
for (const t of ['service_catalog', 'get_promotions', 'match_stylist', 'find_slots', 'hold_slot',
                 'confirm_booking', 'cancel_reschedule', 'hair_profile_read', 'hair_profile_write', 'escalate_to_human'])
  check(t + ' forces no field', JSON.parse(node(t).parameters.inputSchema).required.length === 0);
check('classify_style keeps text required', JSON.parse(node('classify_style').parameters.inputSchema).required.join() === 'text');
for (const f of ['time_window', 'day_part', 'chosen_slot_start', 'stylist_no_preference'])
  check('output schema carries ' + f, JSON.parse(node('Evidence reference schema').parameters.inputSchema).required.indexOf(f) !== -1);

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
