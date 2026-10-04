// Customer-facing reply. The audit row id is NOT shown to the customer; it is
// returned as a sibling field for the test harness and for staff tooling.
const draft   = $('Draft ready').first().json;
const written = $input.first().json;
const zh = draft && /[㐀-鿿]/.test(String(draft.request_text ?? ''));
const logged = !!(written && !written.error && written.id);
let output = String(draft.output ?? '');

// If the audit write failed on a turn that needs a human, the customer would be
// waiting on a request nobody can see. Say so rather than promising follow-up.
if (!logged && draft.requires_human) {
  output += zh ? '\n（系统没能记录这条请求，麻烦你直接联系门店。）'
               : "\n(We couldn't log this request — please contact the salon directly.)";
}

return [{ json: {
  output,
  auto_sent: !!draft.auto_sent,
  requires_human: !!draft.requires_human,
  reason: draft.reason,
  guardrail_pass: draft.guardrail_pass,
  conv_status: draft.conv_status,
  ready: !!draft.ready,
  missing: draft.missing,
  slots: draft.slots_next,
  metrics: draft.metrics,
  logged,
  audit_id: logged ? written.id : null
} }];
