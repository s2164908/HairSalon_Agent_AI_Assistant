// Risk-flagged requests never reach the model. They still have to preserve the
// conversation so the customer can carry on afterwards, so the slot bag is
// passed through untouched rather than reset.
const conv = $('Conversation state').first().json;
const zh = conv.language === 'zh';
const reset = conv.resetRequested === true;
const medical = !reset && /hair\s*loss|alopecia|scalp|allerg|rash|infection|脱发|头皮|过敏/i.test(String(conv.chatInput ?? ''));
const reply = reset
  ? (zh ? '好的，我们从头开始。你想做哪项服务？' : "Sure, let's start over. Which service would you like?")
  : medical
  ? (zh ? '这个涉及头皮健康，我不方便给建议。我已经转给店里的同事，也建议你找专业人士看一下。'
        : "That's a scalp-health question and not something I should advise on. I've passed it to a colleague, and it's worth seeing a professional too.")
  : (zh ? '这个我帮你转给店里的同事处理，他们会尽快联系你。'
        : "I've passed this to a colleague at the salon — they'll be in touch shortly.");

const prior = reset ? {} : ((conv.slots && typeof conv.slots === 'object') ? conv.slots : {});
const recent = (Array.isArray(conv.recentTurns) ? conv.recentTurns : []).concat([String(conv.chatInput || '')]).slice(-3);
const turn = (Number(conv.turnCount) || 0) + 1;

return [{ json: {
  session_id: conv.sessionId,
  request_text: conv.chatInput,
  draft_reply: reply,
  reason: reset ? 'reset' : (medical ? 'health_topic' : 'complaint_or_bargaining'),
  status: reset ? 'answered' : 'pending_human',
  guardrail_pass: true,
  errors: [],
  requires_human: !reset,
  auto_sent: reset,
  tool_calls: [],
  not_configured_tools: [],
  truncated: !!conv.truncated,
  // slots survive the detour
  slots_next: prior,
  slots_json: JSON.stringify(prior),
  recent_turns_json: JSON.stringify(reset ? [] : recent),
  last_question: reset ? '' : String(conv.lastQuestion || ''),
  conv_status: reset ? 'gathering' : 'escalated',
  turn_count: turn,
  missing: Array.isArray(conv.slotsMissing) ? conv.slotsMissing : [],
  proposals: [],
  ready: false,
  metrics: { guardrail_pass: 1, errors_count: 0, hallucination_blocked: 0, tool_call_count: 0,
    escalated: reset ? 0 : 1, agent_failed: 0, tool_failures: 0, not_configured_hit: 0,
    slots_filled: 5 - (Array.isArray(conv.slotsMissing) ? conv.slotsMissing.length : 5), turn: turn, ready: 0 },
  output: reply
} }];
