// FIX P2-7: risk-flagged requests never reach the model at all now. Previously
// every read tool short-circuited to human_required and the agent burned
// iterations and tokens discovering that, before escalating anyway.
const ctx = $input.first().json;
const zh = ctx.language === 'zh';
const medical = /hair\s*loss|alopecia|scalp|allerg|rash|infection|脱发|头皮|过敏/i.test(String(ctx.chatInput ?? ''));
const reply = medical
  ? (zh ? '此问题需要人工处理。涉及头皮、脱发或过敏，请咨询合适的专业人士。'
        : 'This needs a human review. For scalp, hair loss or allergy concerns, please consult an appropriate professional.')
  : (zh ? '此请求需要店员人工复核。'
        : 'This request needs a salon staff member to review it.');
return [{ json: {
  session_id: ctx.sessionId,
  request_text: ctx.chatInput,
  draft_reply: reply,
  reason: medical ? 'health_topic' : 'complaint_or_bargaining',
  status: 'pending',
  guardrail_pass: true,
  errors: [],
  requires_human: true,
  tool_calls: [],
  not_configured_tools: [],
  truncated: !!ctx.truncated,
  metrics: { guardrail_pass: 1, errors_count: 0, hallucination_blocked: 0, tool_call_count: 0, escalated: 1, agent_failed: 0, not_configured_hit: 0 },
  output: (zh ? '[人工复核草稿]\n' : '[DRAFT FOR STAFF REVIEW]\n') + reply
} }];
