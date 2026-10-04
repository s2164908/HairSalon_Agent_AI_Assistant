const j = $input.first().json;
const raw = String(j.chatInput ?? '');

// Sanitise before anything else reads the text: a control character in the customer's
// message must not be able to restructure the draft a staff member reads. The renderer
// re-sanitises table content for the same reason (see 'Render draft').
const stripped = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ');
const text = stripped.slice(0, 6000);

const risk = /hair\s*loss|alopecia|scalp|allerg|rash|infection|refund|complaint|compensation|negotia|cheaper|too expensive|way too much|can you do .{0,24}off|give me .{0,24}off|lower the price|price match|match .{0,16}price|脱发|头皮|过敏|退款|投诉|赔偿|议价|便宜点|太贵|贵了|打个折|降价|能不能.{0,6}(便宜|优惠|折)/i.test(text);

// v2 chose the language of the entire draft with a bare /[CJK]/ test, so an English
// message containing one Chinese word ("I want the 波波头 look") rendered the whole
// English draft in Chinese. Count script coverage instead and only switch when Chinese
// actually dominates; a single loanword, name or emoji no longer flips the turn.
function detectLanguage(s) {
  const han = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (han === 0) return 'en';
  if (latin === 0) return 'zh';
  return han / (han + latin) >= 0.3 ? 'zh' : 'en';
}

return [{ json: {
  chatInput: text,
  truncated: raw.length > 6000,
  sessionId: String(j.sessionId ?? 'internal-test'),
  language: detectLanguage(text),
  forceEscalate: risk,
  identityVerified: false,
  customerId: null,
  channel: 'internal_test',
  shadowMode: true
} }];

