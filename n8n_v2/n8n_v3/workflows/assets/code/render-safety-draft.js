// Render safety draft  (stage 1, pre-screen bypass)
//
// The IF node above diverts health, complaint and bargaining turns away from the
// model entirely: v2 used to let every read tool short-circuit to human_required,
// which burned agent iterations and tokens rediscovering what a regex already knew.
//
// This node emits the SAME envelope as render-draft.js. In v2 the bypass path
// hand-built its own copy of the shape and had already drifted - its metrics block
// omitted `tool_failures` - so the staff-queue row silently alternated between two
// schemas depending on which branch produced it. One contract; both paths fill it.

const ctx = $input.first().json;
const zh = ctx.language === 'zh';
const medical = /hair\s*loss|alopecia|scalp|allerg|rash|infection|脱发|头皮|过敏/i.test(String(ctx.chatInput ?? ''));
const reply = medical
  ? (zh ? '此问题需要人工处理。涉及头皮、脱发或过敏，请咨询合适的专业人士。'
        : 'This needs a human review. For scalp, hair loss or allergy concerns, please consult an appropriate professional.')
  : (zh ? '此请求需要店员人工复核。'
        : 'This request needs a salon staff member to review it.');
const reason = medical ? 'health_topic' : 'complaint_or_bargaining';

return [{ json: {
  session_id: ctx.sessionId,
  request_text: ctx.chatInput,
  draft_reply: reply,
  reason,
  status: 'pending',
  guardrail_pass: true,
  errors: [],
  requires_human: true,
  tool_calls: [],
  not_configured_tools: [],
  truncated: !!ctx.truncated,
  metrics: {
    guardrail_pass: 1,
    errors_count: 0,
    hallucination_blocked: 0,
    tool_call_count: 0,
    escalated: 1,
    agent_failed: 0,
    tool_failures: 0,
    not_configured_hit: 0
  },
  output: (zh ? '[人工复核草稿]\n' : '[DRAFT FOR STAFF REVIEW]\n') + reply
} }];
