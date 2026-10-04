// Fire test conversations at the public chat webhook and record what comes back.
const fs = require('fs');
const URL = 'http://localhost:5678/webhook/21553d4c-0035-444b-ab73-18b528c3b459/chat';
const cases = [
  { id: 'catalog_en',      text: "How much is a men's cut?",                                      expect: 'catalog: Men\'s Cut AUD 45.00' },
  { id: 'catalog_zh',      text: '女士剪发多少钱？',                                                expect: 'catalog zh: 女士剪发造型 AUD 85.00' },
  { id: 'promo_general',   text: 'Do you have any promotions right now?',                          expect: 'promotions: promo_open_all (everyone), NOT expired ones' },
  { id: 'promo_cut',       text: "Any deals on a men's cut?",                                      expect: 'promotions: promo_open_all + promo_everyone_cut' },
  { id: 'promo_expired',   text: 'Is the EOFY sale still on?',                                     expect: 'promotions: must NOT mention promo_eofy_expired / promo_expired_everyone' },
  { id: 'style_longbob',   text: 'I want a long bob',                                              expect: 'style: sty_layered_lob (alias long bob), no clarification' },
  { id: 'style_zh',        text: '我想剪波波头',                                                    expect: 'style zh: sty_blunt_bob' },
  { id: 'style_vague',     text: 'just make it shorter and fresher',                               expect: 'clarify: asks for length/layers' },
  { id: 'stylist_balayage',text: 'Who is good at balayage?',                                       expect: 'stylist: Amy + Marco; Sofia (inactive) excluded; no invented budget' },
  { id: 'stylist_curly',   text: 'I have curly hair and want a curly cut, who should I see?',      expect: 'stylist: Priya first (specialty + texture)' },
  { id: 'booking',         text: 'Can I book a cut for Tuesday at 10am?',                          expect: 'booking: not-connected explanation, escalate=false, no fake confirmation' },
  { id: 'cancel',          text: 'Please cancel my appointment apt_5001',                          expect: 'booking/cancel: not-connected, denies any change' },
  { id: 'profile',         text: 'Can you save my hair type? It is wavy and thick.',               expect: 'profile: questionnaire/consent text, nothing saved' },
  { id: 'health_bypass',   text: 'My scalp is itchy and I am losing hair, what should I do?',      expect: 'BYPASS health: professional referral, tool_calls 0' },
  { id: 'bargain_bypass',  text: 'That is too expensive, can you do 50% off?',                     expect: 'BYPASS bargaining: staff review' },
  { id: 'complaint_zh',    text: '上次染的颜色不对，我要投诉退款',                                    expect: 'BYPASS complaint zh: 人工复核' },
  { id: 'extensions',      text: 'Do you do hair extensions?',                                     expect: 'catalog with empty ids OR clarify; must not invent a service' },
  { id: 'greeting',        text: 'hi',                                                             expect: 'greeting text' }
];
(async () => {
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    let status = 0, body = null, text = '';
    try {
      const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'sendMessage', sessionId: 'test-' + c.id + '-' + Date.now(), chatInput: c.text }), signal: AbortSignal.timeout(150000) });
      status = r.status; text = await r.text();
      try { body = JSON.parse(text); } catch { body = null; }
    } catch (e) { text = 'FETCH ERROR ' + e.message; }
    const ms = Date.now() - t0;
    const out = body?.output ?? text;
    results.push({ id: c.id, input: c.text, expect: c.expect, status, ms, output: out, reason: body?.reason, guardrail_pass: body?.guardrail_pass, metrics: body?.metrics, queued: body?.queued });
    console.log('\n[' + c.id + '] ' + status + ' ' + ms + 'ms   expect: ' + c.expect);
    console.log('  Q: ' + c.text);
    console.log('  A: ' + String(out).replace(/\n/g, '\n     '));
    if (body?.metrics) console.log('  reason=' + body.reason + ' guardrail_pass=' + body.guardrail_pass + ' tools=' + body.metrics.tool_call_count + ' escalated=' + body.metrics.escalated + ' halluc_blocked=' + body.metrics.hallucination_blocked + ' queued=' + body.queued);
  }
  fs.writeFileSync(__dirname + '/chat_results.json', JSON.stringify(results, null, 2));
  console.log('\nsaved ' + results.length + ' results -> chat_results.json');
})();
