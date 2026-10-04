// Global error handler  (PLAN.md Phase 9: "错误工作流（Error Trigger）+ 每日人工抽检")
//
// v2 had no error workflow at all: a throw in any Code node killed the chat turn,
// and the draft vanished with the execution. This workflow records the failure in
// the same staff-review table as a normal draft, so nothing is silently lost.
//
// It deliberately does NOT reference an error workflow of its own. A failure while
// recording a failure must stop, not loop - that is what makes the retry budget
// bounded.
//
// Emits exactly the six columns `Queue for staff review` / `Queue agent failure`
// map: session_id, request_text, draft_reply, reason, status, guardrail_pass.

const payload = $input.first().json ?? {};
const execution = payload.execution ?? {};
const workflow = payload.workflow ?? {};
// The Error Trigger is flat: { execution, workflow, trigger }. Be defensive about
// older/newer shapes rather than throwing inside the error handler.
const failure = execution.error ?? payload.error ?? {};

const failedNode = execution.lastNodeExecuted ?? 'unknown node';
const workflowName = workflow.name ?? 'unknown workflow';
const message = String(
  (failure && (failure.message || failure.description)) || payload.message || 'unknown error',
).replace(/\s+/g, ' ').trim().slice(0, 800);

return [{ json: {
  session_id: 'error_' + String(execution.id ?? workflow.id ?? 'unknown'),
  request_text: 'ERROR in ' + workflowName + ' / ' + failedNode,
  draft_reply: '[AGENT FAILURE] ' + failedNode + ': ' + message,
  reason: 'agent_failed',
  status: 'pending',
  guardrail_pass: false
} }];
