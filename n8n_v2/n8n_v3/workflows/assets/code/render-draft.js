// Render draft  (stage 4, second half)
//
// Second half of v2's "Validate evidence and render draft". The guardrail node
// has already decided WHETHER the turn is safe and collected the evidence; this
// node decides WHAT WORDS the staff member reads. Every factual token - price,
// currency, duration, promotion title, stylist name, ordering - is copied out of
// `evidence`, i.e. out of a tool result from this turn. None of it is model prose,
// which is why a draft cannot invent a price. No LLM is involved in this node.

const g = $input.first().json;
const ctx = g.ctx;
const zh = ctx.language === 'zh';
const p = g.parsed ?? {};
const evidence = g.evidence ?? { services: [], promotions: [], stylists: [], styles: [] };
const errors = g.errors ?? [];
const toolCalls = g.tool_calls ?? [];
const notConfigured = g.not_configured_tools ?? [];
const toolFailures = g.tool_failures ?? [];
const hitBooking = g.hit_booking === true;
const hitProfile = g.hit_profile === true;
const escalateGeneric = g.escalate_generic === true;
const escalate = g.escalate === true;
let reason = g.reason;

// FIX P3: table content is echoed into drafts. Strip control characters and
// collapse whitespace so an instruction injected into a service name cannot
// restructure the draft that a staff member reads.
function safe(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function money(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : '?'; }

// Evidence-backed prices are rendered whenever the model referenced a service,
// whatever intent it picked. Live run: "How much is a men's cut?" came back as
// intent=promotions with service_ids=[svc_cut_men]; the price must still show.
const priceRows = evidence.services.filter(r => (Array.isArray(p.service_ids) ? p.service_ids : []).indexOf(r.service_id) !== -1);
const priceLines = priceRows.map(r => safe(zh ? (r.name_zh || r.name) : r.name) + ' - ' + safe(r.currency, 8) + ' ' + money(r.price) + ' / ' + Number(r.duration_min) + (zh ? ' 分钟' : ' minutes')).join('\n');
const styleRow = p.taxonomy_id ? evidence.styles.find(r => r.taxonomy_id === p.taxonomy_id) : null;
const styleLine = styleRow
  ? (zh ? '匹配的发型：' : 'Matched hairstyle: ') + safe(zh ? styleRow.name_zh : styleRow.name_en) + ' [' + safe(styleRow.taxonomy_id, 60) + ']' + (zh ? '。请确认这是否是您想要的发型。' : '. Please confirm this is the style you mean.')
  : '';
let generic = false;

let reply = '';
if (hitBooking) {
  reply = zh
    ? '预约系统与身份验证尚未连接。未创建、修改或取消任何预约，请由店员协助。'
    : 'The booking system and identity verification are not connected. No appointment was created, changed or cancelled; a salon staff member must assist.';
  reason = 'booking_setup_required';
} else if (hitProfile) {
  reply = zh
    ? '请自报发丝形态、密度、孔隙度以及染烫漂历史。不确定的项目可留空；确认资料与保存授权后才能建档。目前未保存资料。'
    : 'Please self-report your texture, density, porosity and colour/perm/bleach history. Unknown fields can stay blank. Confirmation and storage consent are required before saving; no profile has been saved.';
  reason = 'profile_setup_required';
} else if (escalateGeneric) {
  reply = zh ? '此请求需要店员人工复核。' : 'This request needs a salon staff member to review it.';
  generic = true;
} else if (p.intent === 'catalog') {
  reply = priceLines || (zh ? '尚无已核实的服务价格，请让店员提供价目表。' : 'No verified service prices are configured yet. Please ask the salon for its price list.');
} else if (p.intent === 'promotions') {
  const rows = evidence.promotions.filter(r => (p.promotion_ids ?? []).indexOf(r.promotion_id) !== -1);
  reply = rows.length
    ? rows.map(r => safe(r.title) + ' [' + safe(r.promotion_id, 60) + ']').join('\n')
    : (zh ? '当前没有可核实且适用的促销。' : 'There are currently no verified eligible promotions.');
} else if (p.intent === 'style') {
  reply = styleLine || (zh ? '请描述长度、层次及刘海，帮助确认发型。' : 'Please describe the length, layers and fringe so we can clarify the style.');
} else if (p.intent === 'stylist') {
  const rows = evidence.stylists.filter(r => (p.stylist_ids ?? []).indexOf(r.stylist_id) !== -1);
  const labels = {
    style_specialty: zh ? '发型专长' : 'style specialty',
    texture_experience: zh ? '自报发质经验' : 'experience with your self-reported texture',
    language_match: zh ? '语言匹配' : 'language match'
  };
  reply = rows.length
    ? rows.map(r => safe(r.name, 80) + ' - ' + (r.reasons ?? []).map(k => labels[k] || k).join(', ')).join('\n') +
      (zh ? '\n档期尚未核实。' : '\nAvailability has not been verified.')
    : (zh ? '没有符合条件的发型师。可以放宽语言或价位条件后再查。' : 'No matching stylists are configured. You can relax language or price-tier preferences and try again.');
} else {
  const qs = {
    service: zh ? '您想了解哪项服务？' : 'Which service are you interested in?',
    style: zh ? '您想要什么发型或长度？' : 'What hairstyle or length would you like?',
    texture: zh ? '您自报的发丝形态是什么？' : 'How would you describe your hair texture?',
    language: zh ? '您偏好哪种沟通语言？' : 'Which language do you prefer?',
    budget: zh ? '您偏好的价位是多少？' : 'What price tier do you prefer?',
    profile_consent: zh ? '是否同意在核实身份并确认资料后保存发质档案？' : 'Would you consent to saving a hair profile after identity verification and confirmation?',
    none: zh ? '您好，我可以协助了解服务、促销和发型。本对话为内部人工复核草稿。' : 'Hello! I can help with services, promotions and hairstyles. This is an internal draft for staff review.'
  };
  reply = qs[p.question] ?? qs.none;
}

if (!generic && p.intent !== 'style' && styleLine) reply = styleLine + '\n' + reply;
if (!generic && p.intent !== 'catalog' && priceLines) reply = priceLines + '\n' + reply;

if (ctx.truncated) reply += zh ? '\n（注意：用户输入过长已被截断，请复核原文。）' : '\n(Note: the user message was truncated; please check the original.)';

const hallucinationBlocked = errors.filter(e => e.indexOf('unsupported_') === 0).length;

// The staff-queue row. This key set IS the contract: render-safety-draft.js emits
// the identical shape for the pre-screen path, so the Data Table node below can
// never receive two different schemas. v2 drifted here - the bypass node omitted
// `tool_failures` from its metrics block, so the same column silently alternated
// between 8 and 7 keys.
return [{ json: {
  session_id: ctx.sessionId,
  request_text: ctx.chatInput,
  draft_reply: reply,
  reason,
  status: 'pending',
  guardrail_pass: errors.length === 0,
  errors,
  requires_human: true,
  tool_calls: toolCalls,
  not_configured_tools: notConfigured,
  truncated: !!ctx.truncated,
  // Ready-made numeric metrics: map these straight into PLAN.md Phase 6.
  metrics: {
    guardrail_pass: errors.length === 0 ? 1 : 0,
    errors_count: errors.length,
    hallucination_blocked: hallucinationBlocked,
    tool_call_count: toolCalls.length,
    escalated: escalate ? 1 : 0,
    agent_failed: g.agent_failed ? 1 : 0,
    tool_failures: toolFailures.length,
    not_configured_hit: notConfigured.length ? 1 : 0
  },
  output: (zh ? '[人工复核草稿]\n' : '[DRAFT FOR STAFF REVIEW]\n') + reply
} }];

