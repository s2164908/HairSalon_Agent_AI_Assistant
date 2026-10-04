let q = {};
try { q = typeof query === 'string' ? JSON.parse(query || '{}') : (query ?? {}); }
catch { return JSON.stringify({ ok: false, tool: 'find_slots', error: 'invalid_input' }); }

const conv  = $('Conversation state').first().json;
if (conv.forceEscalate) return JSON.stringify({ ok: false, tool: 'find_slots', error: 'human_required' });
const svcSnap = $('Services snapshot').first().json;
const stySnap = $('Stylists snapshot').first().json;
const schSnap = $('Schedule snapshot').first().json;
const aptSnap = $('Appointments snapshot').first().json;
if (svcSnap.degraded || stySnap.degraded || schSnap.degraded || aptSnap.degraded)
  return JSON.stringify({ ok: false, tool: 'find_slots', error: 'catalog_unavailable', retryable: true });

// --- Sydney-local time helpers ---------------------------------------------
const TZ = 'Australia/Sydney';
function tzOffsetMs(d) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const part of dtf.formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value;
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, Number(p.minute), Number(p.second)) - d.getTime();
}
// wall-clock (y, m, d, hh, mm) in Sydney -> epoch ms
function localMs(y, mo, d, hh, mm) {
  let ts = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo - 1, d, hh, mm, 0, 0) - tzOffsetMs(new Date(ts));
  return ts;
}
function todayParts() {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()))
    if (part.type !== 'literal') p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}
function fmtSlot(ms, durMin) {
  const dtf = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return dtf.format(new Date(ms)).replace(',', '') + '-' + new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms + durMin * 60000));
}
const isoDate = s => { const m = String(s ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };

// --- resolve the service (slot state wins; the model need not repeat it) -----
const services = (svcSnap.rows || []).filter(r => r.active === true);
const slotSvc = conv.slots && conv.slots.service && conv.slots.service.id;
const wantSvc = String(q.service_id ?? '').trim() || slotSvc || '';
const service = services.find(r => r.service_id === wantSvc) || null;
if (!service) {
  return JSON.stringify({ ok: true, tool: 'find_slots', slots: [], reserved: false,
    result: 'SERVICE_REQUIRED',
    final_instruction: 'A service must be confirmed before times can be looked up. Do NOT call any other tool. Answer now asking the customer which service they want, escalate=false.' });
}
const durMin = Number(service.duration_min) || 60;

// --- candidate stylists ------------------------------------------------------
const arr = x => { try { const a = JSON.parse(x || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const levelOf = { 1: 'junior', 2: 'senior', 3: 'director' };
const allowedLevels = arr(service.allowed_stylist_levels);
const slotSty = conv.slots && conv.slots.stylist && conv.slots.stylist.id;
const askedSty = String(q.stylist_id ?? '').trim();
// Live run: the model passed "sty_jayden" (wrong prefix) and the empty result
// read as "no stylist can perform this service". An id we do not recognise is
// reported as such and simply dropped as a filter.
const unknownStylist = !!askedSty && !(stySnap.rows || []).some(r => r.stylist_id === askedSty);
const wantSty = unknownStylist ? '' : (askedSty || slotSty || '');
let candidates = (stySnap.rows || []).filter(r =>
  r.active === true &&
  (!allowedLevels.length || allowedLevels.indexOf(levelOf[Number(r.price_tier)]) !== -1) &&
  (!wantSty || r.stylist_id === wantSty));
if (!candidates.length) {
  return JSON.stringify({ ok: true, tool: 'find_slots', slots: [], reserved: false,
    result: 'NO_ELIGIBLE_STYLIST', unknown_stylist_id: unknownStylist ? askedSty : null,
    detail: wantSty ? 'that stylist cannot perform this service' : 'no active stylist can perform this service',
    final_instruction: 'No stylist on shift can perform this service. This result is final. Do NOT call any other tool. Answer now explaining that, escalate=false.' });
}

// --- search window -----------------------------------------------------------
const t = todayParts();
const from = isoDate(q.date_from) || t;
const toRaw = isoDate(q.date_to) || null;
const startMs = localMs(from.y, from.m, from.d, 0, 0);
const MAX_DAYS = 14;
const endMs = toRaw ? localMs(toRaw.y, toRaw.m, toRaw.d, 23, 59) : startMs + 7 * 86400000;
const partOf = String(q.day_part ?? '').trim().toLowerCase();
const nowMs = Date.now();

// busy blocks: only confirmed and held actually occupy a stylist
const busy = (aptSnap.rows || [])
  .filter(r => ['confirmed', 'held'].indexOf(String(r.status)) !== -1)
  .map(r => ({ stylist_id: r.stylist_id, s: Date.parse(r.start), e: Date.parse(r.end) }))
  .filter(b => Number.isFinite(b.s) && Number.isFinite(b.e));

const schedule = (schSnap.rows || []);
const out = [];
for (let dayMs = startMs; dayMs <= endMs && out.length < 40; dayMs += 86400000) {
  const dp = {};
  for (const part of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(dayMs)))
    if (part.type !== 'literal') dp[part.type] = part.value;
  const Y = Number(dp.year), M = Number(dp.month), D = Number(dp.day);
  const weekday = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  const dayIso = dp.year + '-' + dp.month + '-' + dp.day;

  for (const st of candidates) {
    const shifts = schedule.filter(r => r.stylist_id === st.stylist_id && Number(r.weekday) === weekday &&
      (!r.valid_from || r.valid_from <= dayIso) && (!r.valid_to || r.valid_to >= dayIso));
    for (const sh of shifts) {
      const sm = String(sh.start_time || '').split(':'), em = String(sh.end_time || '').split(':');
      if (sm.length < 2 || em.length < 2) continue;
      const shiftStart = localMs(Y, M, D, Number(sm[0]), Number(sm[1]));
      const shiftEnd   = localMs(Y, M, D, Number(em[0]), Number(em[1]));
      const blocks = busy.filter(b => b.stylist_id === st.stylist_id && b.e > shiftStart && b.s < shiftEnd)
        .sort((a, b) => a.s - b.s);
      // walk the shift on the half hour, skipping anything that overlaps a block
      for (let cur = shiftStart; cur + durMin * 60000 <= shiftEnd; cur += 30 * 60000) {
        const fin = cur + durMin * 60000;
        if (cur < nowMs) continue;
        if (blocks.some(b => b.s < fin && b.e > cur)) continue;
        if (partOf) {
          const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(cur)));
          if (partOf === 'morning'   && hr >= 12) continue;
          if (partOf === 'afternoon' && (hr < 12 || hr >= 17)) continue;
          if (partOf === 'evening'   && hr < 17) continue;
        }
        out.push({ stylist_id: st.stylist_id, stylist_name: st.name, start: new Date(cur).toISOString(),
          end: new Date(fin).toISOString(), label: fmtSlot(cur, durMin), reserved: false });
        break; // one suggestion per stylist per shift keeps the list readable
      }
    }
  }
}

out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || String(a.stylist_id).localeCompare(String(b.stylist_id)));
const slots = out.slice(0, 6);

return JSON.stringify({
  ok: true, tool: 'find_slots',
  timezone: TZ,
  service_id: service.service_id,
  duration_min: durMin,
  unknown_stylist_id: unknownStylist ? askedSty : null,
  searched: { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString(), day_part: partOf || null, stylist_id: wantSty || null },
  // Nothing is held. Say so everywhere it could be mistaken for a booking.
  reserved: false,
  slots,
  ...(slots.length === 0
    ? { result: 'NO_AVAILABILITY',
        final_instruction: 'No free time matches that request. This result is final for this window. Do NOT call any other tool. Answer now saying so and inviting a different day or time, escalate=false.' }
    : { final_instruction: 'These times are NOT reserved. Do NOT call any other tool. Answer now presenting them and asking the customer to pick one, escalate=false.' })
});
