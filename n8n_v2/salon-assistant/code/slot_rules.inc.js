// ---------------------------------------------------------------------------
// Canonical slot definitions. Injected verbatim into BOTH the "Conversation
// state" node and the "Validate" node at build time (placeholder __SLOT_RULES__)
// so the two can never disagree about what is missing or what to ask next.
// ---------------------------------------------------------------------------

// Order is the real salon booking order: what → which look → when (range) →
// who → which exact slot. A slot can only be asked for once everything it
// depends on is known, so this doubles as the priority list.
const SLOT_ORDER = ['service', 'style', 'time_window', 'stylist', 'time_slot'];

// Style only matters for cut/colour work. A blow dry or a bond treatment needs
// no taxonomy entry, and asking for one would be a dead end.
const STYLE_IRRELEVANT_SERVICES = ['svc_treat_olaplex', 'svc_blowdry', 'svc_treat_keratin'];

function slotFilled(slots, key) {
  const s = slots || {};
  if (key === 'service')     return !!(s.service && s.service.id);
  if (key === 'style')       return !!(s.style && s.style.taxonomy_id);
  if (key === 'time_window') return !!(s.time && s.time.window_from);
  if (key === 'stylist')     return !!(s.stylist && (s.stylist.id || s.stylist.any === true));
  if (key === 'time_slot')   return !!(s.time && s.time.chosen_slot && s.time.chosen_slot.start);
  return false;
}

function slotApplicable(slots, key) {
  const s = slots || {};
  if (key !== 'style') return true;
  // unknown service yet -> assume style will be needed, so it keeps its priority
  if (!(s.service && s.service.id)) return true;
  return STYLE_IRRELEVANT_SERVICES.indexOf(s.service.id) === -1;
}

function missingSlots(slots) {
  const out = [];
  for (const k of SLOT_ORDER) if (slotApplicable(slots, k) && !slotFilled(slots, k)) out.push(k);
  return out;
}

// Adaptive questioning: >=3 gaps -> ask only the highest-priority one; 1-2 gaps
// -> ask them together. time_slot is never "asked" in the abstract, it is
// answered by presenting real slots, so it is always handled on its own.
function slotsToAsk(missing) {
  if (!missing.length) return [];
  if (missing[0] === 'time_slot') return ['time_slot'];
  const askable = missing.filter(k => k !== 'time_slot');
  if (!askable.length) return ['time_slot'];
  return askable.length >= 3 ? [askable[0]] : askable;
}

const SLOT_LABEL = {
  service:     { zh: '服务项目', en: 'service' },
  style:       { zh: '发型',     en: 'hairstyle' },
  time_window: { zh: '方便的时间段', en: 'when you are free' },
  stylist:     { zh: '发型师',   en: 'stylist' },
  time_slot:   { zh: '具体时段', en: 'a specific time' }
};

// One short line per confirmed slot, used in both the model prompt and the
// customer-facing progress block.
function slotLines(slots, zh) {
  const s = slots || {}, out = [];
  if (slotFilled(s, 'service')) {
    const v = s.service;
    out.push((zh ? '服务：' : 'Service: ') + (zh ? (v.name_zh || v.name) : v.name) +
      (Number.isFinite(Number(v.price)) ? ' — ' + (v.currency || 'AUD') + ' ' + Number(v.price).toFixed(2) : '') +
      (Number.isFinite(Number(v.duration_min)) ? ' / ' + Number(v.duration_min) + (zh ? ' 分钟' : ' min') : ''));
  }
  if (slotFilled(s, 'style')) {
    const v = s.style;
    out.push((zh ? '发型：' : 'Style: ') + (zh ? (v.name_zh || v.name_en) : (v.name_en || v.name_zh)));
  }
  if (slotFilled(s, 'stylist')) {
    out.push((zh ? '发型师：' : 'Stylist: ') + (s.stylist.any === true ? (zh ? '都可以' : 'no preference') : s.stylist.name));
  }
  if (slotFilled(s, 'time_slot')) {
    out.push((zh ? '时间：' : 'Time: ') + s.time.chosen_slot.label);
  } else if (slotFilled(s, 'time_window')) {
    out.push((zh ? '时间范围：' : 'When: ') + s.time.window_label);
  }
  return out;
}
