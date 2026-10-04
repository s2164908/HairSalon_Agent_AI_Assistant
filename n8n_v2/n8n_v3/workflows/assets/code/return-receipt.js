const draft   = $('Draft ready').first().json;
const written = $input.first().json;
const zh = /[㐀-鿿]/.test(String(draft.request_text ?? ''));
const queued = !!(written && !written.error && written.id);
const tail = queued
  ? (zh ? '\n\n复核队列条目：' : '\n\nReview queue entry: ') + written.id
  : (zh ? '\n\n[警告] 写入复核队列失败，本草稿未被记录，请人工留存。'
        : '\n\n[WARNING] The review queue write failed - this draft was NOT recorded. Please capture it manually.');
return [{ json: {
  output: String(draft.output ?? '') + tail,
  queued,
  queue_id: queued ? written.id : null,
  metrics: draft.metrics,
  reason: draft.reason,
  guardrail_pass: draft.guardrail_pass
} }];
