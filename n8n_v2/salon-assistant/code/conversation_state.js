// Loads the per-session slot state written by the previous turn and turns it
// into (a) structured state for the renderer and (b) a prompt block for the
// model. This node replaces the removed "Six turn memory": everything the model
// learns about earlier turns now comes from verified slots, never from raw
// prior tool observations.
const ctx = $('Normalize and screen input').first().json;
const zh = ctx.language === 'zh';

// __SLOT_RULES__

const items = $input.all().map(i => i.json);
const degraded = items.some(r => r && r.error);
// The Data Table `get` is filtered by session_id, but be defensive: never adopt
// another session's row.
const row = degraded ? null : items.find(r => r && r.session_id === ctx.sessionId) || null;

const TTL_MS = 24 * 60 * 60 * 1000;
const parse = (v, fallback) => { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : fallback; } catch { return fallback; } };

let slots = {}, recentTurns = [], lastQuestion = '', turnCount = 0, status = 'gathering', stale = false;
if (row) {
  const age = Date.now() - Date.parse(row.updated_at || row.updatedAt || 0);
  stale = Number.isFinite(age) && age > TTL_MS;
  if (!stale) {
    slots = parse(row.slots, {});
    recentTurns = Array.isArray(parse(row.recent_turns, [])) ? parse(row.recent_turns, []) : [];
    lastQuestion = String(row.last_question || '');
    turnCount = Number(row.turn_count) || 0;
    status = String(row.status || 'gathering');
  }
}
// A customer can always start over.
const resetRequested = /^\s*(reset|restart|start over|重来|重新开始|取消重来)\s*$/i.test(String(ctx.chatInput || ''));
if (resetRequested) { slots = {}; recentTurns = []; lastQuestion = ''; turnCount = 0; status = 'gathering'; }

const missing = missingSlots(slots);
const known = slotLines(slots, zh);

// The prompt the agent actually receives. Static rules live in the system
// message; everything session-specific is assembled here so it is auditable.
const promptParts = [];
if (known.length) {
  promptParts.push((zh ? '【已确认的信息 — 不要重复询问，也不要重新验证】' : '[ALREADY CONFIRMED - do not ask again, do not re-verify]'));
  for (const l of known) promptParts.push('- ' + l);
  const ids = [];
  if (slots.service && slots.service.id) ids.push('service_id=' + slots.service.id);
  if (slots.style && slots.style.taxonomy_id) ids.push('taxonomy_id=' + slots.style.taxonomy_id);
  if (slots.stylist && slots.stylist.id) ids.push('stylist_id=' + slots.stylist.id);
  if (ids.length) promptParts.push((zh ? '已确认的 ID（可直接在输出中使用）：' : 'Confirmed IDs (safe to use in your output): ') + ids.join(', '));
}
if (missing.length) {
  promptParts.push((zh ? '【还缺】' : '[STILL MISSING]') + ' ' + missing.map(k => SLOT_LABEL[k] ? SLOT_LABEL[k][zh ? 'zh' : 'en'] : k).join(zh ? '、' : ', '));
}
if (lastQuestion) {
  promptParts.push((zh ? '【上一轮我们问的是】' : '[WE ASKED LAST TURN]') + ' ' + lastQuestion +
    (zh ? ' — 顾客这一轮多半是在回答它。' : ' - the customer is most likely answering it now.'));
}
if (recentTurns.length) {
  promptParts.push(zh ? '【顾客最近几轮的原话】' : '[RECENT CUSTOMER MESSAGES]');
  recentTurns.slice(-3).forEach((t, i) => promptParts.push((i + 1) + '. ' + t));
}
// The model has no clock. Without this it cannot resolve "this Wednesday".
const TZ = 'Australia/Sydney';
const todayLabel = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
promptParts.push((zh ? '【今天】' : '[TODAY]') + ' ' + todayLabel + ' (' + TZ + ')');
promptParts.push((zh ? '【顾客本轮说】' : '[CUSTOMER SAYS NOW]') + '\n' + String(ctx.chatInput || ''));

return [{ json: {
  ...ctx,
  slots,
  slotsMissing: missing,
  knownLines: known,
  status,
  lastQuestion,
  recentTurns,
  turnCount,
  // the customer's own words from earlier turns: still customer evidence, so a
  // service named two turns ago can settle a slot without the model paraphrasing
  earlierWords: recentTurns.join(' \n '),
  convDegraded: degraded,
  stateStale: stale,
  resetRequested,
  stateRowExists: !!row,
  agentPrompt: promptParts.join('\n')
} }];
