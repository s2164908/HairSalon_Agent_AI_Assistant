const j = $input.first().json;
const raw = String(j.chatInput ?? '');
const text = raw.slice(0, 6000);
const risk = /hair\s*loss|alopecia|scalp|allerg|rash|infection|refund|complaint|compensation|negotia|cheaper|too expensive|way too much|can you do .{0,24}off|give me .{0,24}off|lower the price|price match|match .{0,16}price|脱发|头皮|过敏|退款|投诉|赔偿|议价|便宜点|太贵|贵了|打个折|降价|能不能.{0,6}(便宜|优惠|折)/i.test(text);
return [{ json: {
  chatInput: text,
  truncated: raw.length > 6000,
  sessionId: String(j.sessionId ?? 'internal-test'),
  language: /[㐀-鿿]/.test(text) ? 'zh' : 'en',
  forceEscalate: risk,
  identityVerified: false,
  customerId: null,
  channel: 'internal_test',
  shadowMode: true
} }];
