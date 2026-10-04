// Integration check for the multi-turn loop: scripted conversations that SHARE a
// sessionId, fired at the live chat webhook. run_chat.js stays as the single-turn
// regression suite; this one exercises slot accumulation across turns.
const fs = require('fs');
const path = require('path');
const URL = 'http://localhost:5678/webhook/21553d4c-0035-444b-ab73-18b528c3b459/chat';

const conversations = [
  { id: 'progressive', title: '渐进补齐：每轮只给一点信息',
    turns: ['我想剪个齐肩的层次发', '这周四下午方便', 'Amy', '第一个时段就行'] },
  { id: 'all_at_once', title: '一次说全：应当直接逼近 ready',
    turns: ["I'd like a men's cut with Jayden on Thursday morning"] },
  { id: 'change_mind', title: '中途改主意：只重算时间，其余保留',
    turns: ["I want a men's cut", 'Thursday afternoon', 'actually can we do Friday instead?'] },
  { id: 'cross_turn_ref', title: '跨轮指代：第二轮不重复说服务名',
    turns: ['do you have any promotions?', "how much is a women's cut?", 'does that promotion apply to it?'] },
  { id: 'escalate_midflow', title: '中途升级：旁路后槽位必须还在',
    turns: ["I'd like a women's cut", '我最近掉发很严重怎么办', 'ok, Thursday afternoon then'] },
  { id: 'reset', title: '重置：顾客要求重新开始',
    turns: ["I want a men's cut", '重新开始', 'what services do you offer?'] }
];

const post = async (sessionId, chatInput) => {
  const t0 = Date.now();
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'sendMessage', sessionId, chatInput }), signal: AbortSignal.timeout(150000) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { ms: Date.now() - t0, status: r.status, body, text };
  } catch (e) { return { ms: Date.now() - t0, status: 0, body: null, text: 'FETCH ERROR ' + e.message }; }
};

const slotDigest = s => {
  if (!s || typeof s !== 'object') return '-';
  const bits = [];
  if (s.service) bits.push('svc=' + s.service.id);
  if (s.style) bits.push('style=' + s.style.taxonomy_id);
  if (s.stylist) bits.push('stylist=' + (s.stylist.any ? 'any' : s.stylist.id));
  if (s.time && s.time.window_from) bits.push('win=' + s.time.window_from + (s.time.day_part ? '/' + s.time.day_part : ''));
  if (s.time && s.time.offered) bits.push('offered=' + s.time.offered.length);
  if (s.time && s.time.chosen_slot) bits.push('slot=' + s.time.chosen_slot.label);
  if (s.quote) bits.push('total=' + s.quote.currency + s.quote.total);
  return bits.length ? bits.join(' ') : '(empty)';
};

(async () => {
  const results = [];
  for (const conv of conversations) {
    const sessionId = 'conv-' + conv.id + '-' + Date.now();
    console.log('\n' + '='.repeat(78) + '\n' + conv.title + '   [' + conv.id + ']\n' + '='.repeat(78));
    const turns = [];
    for (let i = 0; i < conv.turns.length; i++) {
      const q = conv.turns[i];
      const res = await post(sessionId, q);
      const b = res.body || {};
      console.log('\n  T' + (i + 1) + ' 顾客: ' + q);
      console.log('     回复: ' + String(b.output ?? res.text).replace(/\n/g, '\n           '));
      console.log('     状态: ' + b.conv_status + ' | reason=' + b.reason + ' | ready=' + b.ready +
        ' | auto=' + b.auto_sent + ' | 缺=' + JSON.stringify(b.missing) + ' | ' + res.ms + 'ms');
      console.log('     槽位: ' + slotDigest(b.slots));
      turns.push({ q, status: res.status, ms: res.ms, output: b.output ?? res.text, conv_status: b.conv_status,
        reason: b.reason, ready: b.ready, auto_sent: b.auto_sent, missing: b.missing, slots: b.slots, metrics: b.metrics });
    }
    results.push({ id: conv.id, title: conv.title, sessionId, turns });
  }
  fs.writeFileSync(path.join(__dirname, 'conversation_results.json'), JSON.stringify(results, null, 2));

  console.log('\n' + '='.repeat(78) + '\n汇总\n' + '='.repeat(78));
  for (const c of results) {
    const last = c.turns[c.turns.length - 1];
    const grew = c.turns.map(t => (t.slots ? Object.keys(t.slots).length : 0));
    const monotonic = grew.every((n, i) => i === 0 || n >= grew[i - 1]);
    console.log('  ' + c.id.padEnd(18) + ' 轮数=' + c.turns.length +
      ' 终态=' + last.conv_status + ' ready=' + last.ready +
      ' 槽位增长=' + grew.join('->') + (monotonic ? '' : '  [非单调]') +
      ' 失败=' + c.turns.filter(t => t.status !== 200).length);
  }
  console.log('\nsaved -> conversation_results.json');
})();
