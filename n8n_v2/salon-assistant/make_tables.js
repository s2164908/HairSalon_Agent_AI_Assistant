// Transform mockdata.jsonc into the column shapes the workflow's tool code expects,
// ready to be created as local n8n Data Tables.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'mockdata.jsonc'), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const mock = JSON.parse(src).data;

const tierOf = { junior: 1, senior: 2, director: 3 };
const lang = l => l.startsWith('zh') ? 'zh' : l;
const J = v => JSON.stringify(v);

const aliases = {
  sty_blunt_bob: ['bob', 'blunt bob', '波波头'],
  sty_layered_lob: ['lob', 'long bob', 'layered lob', '齐肩'],
  sty_curtain_bangs: ['curtain bangs', 'curtain fringe', '八字刘海', '刘海'],
  sty_wolf_cut: ['wolf cut', '狼尾'],
  sty_pixie: ['pixie', 'pixie cut', '精灵'],
  sty_curly_shape: ['curly cut', 'dry cut', 'curly shaping', '卷发干剪'],
  sty_buzz_fade: ['fade', 'skin fade', 'buzz cut', '推剪'],
  sty_balayage: ['balayage', '挑染'],
  sty_full_bleach_tone: ['bleach', 'bleach and tone', '漂染'],
  sty_root_touchup: ['root touch up', 'roots', '补根'],
  sty_korean_perm: ['korean perm', 'digital perm', '数码烫', '烫'],
  sty_keratin_smooth: ['keratin', 'keratin smoothing', '角蛋白']
};

// Working hours. weekday uses JS Date#getDay(): 0=Sun … 6=Sat. Salon is closed
// Mondays. No roster data existed in mockdata.jsonc, so this is newly authored;
// keep it plausible rather than uniform so find_slots has real edges to hit.
const roster = {
  stl_amy:    { days: [2, 3, 4, 5, 6], start: '09:00', end: '18:00' },  // Tue-Sat
  stl_marco:  { days: [3, 4, 5, 6, 0], start: '10:00', end: '19:00' },  // Wed-Sun
  stl_priya:  { days: [2, 3, 4, 5, 6], start: '09:00', end: '17:00' },  // Tue-Sat
  stl_jayden: { days: [4, 5, 6, 0],    start: '10:00', end: '18:00' }   // Thu-Sun
  // stl_sofia is on leave (active:false) — deliberately has no roster rows
};

const scheduleRows = [];
for (const [stylist_id, r] of Object.entries(roster)) {
  for (const weekday of r.days) {
    scheduleRows.push({
      stylist_id, weekday, start_time: r.start, end_time: r.end,
      valid_from: '2026-01-01', valid_to: '2026-12-31'
    });
  }
}

// Busy blocks. mockdata's appointments are the seed; only confirmed/held actually
// block a slot. A few extra near-term blocks are added so the week the tests probe
// (2026-09-16 .. 2026-09-20) is not trivially wide open.
const appointmentRows = mock.appointments.map(a => ({
  appointment_id: a.id, stylist_id: a.stylist_id, service_id: a.service_id,
  start: a.start, end: a.end, status: a.status
})).concat([
  { appointment_id: 'apt_6001', stylist_id: 'stl_amy',    service_id: 'svc_color_balayage', start: '2026-09-16T09:00:00+10:00', end: '2026-09-16T12:00:00+10:00', status: 'confirmed' },
  { appointment_id: 'apt_6002', stylist_id: 'stl_amy',    service_id: 'svc_cut_women',      start: '2026-09-16T13:00:00+10:00', end: '2026-09-16T14:00:00+10:00', status: 'confirmed' },
  { appointment_id: 'apt_6003', stylist_id: 'stl_priya',  service_id: 'svc_treat_keratin',  start: '2026-09-17T09:00:00+10:00', end: '2026-09-17T12:00:00+10:00', status: 'confirmed' },
  { appointment_id: 'apt_6004', stylist_id: 'stl_marco',  service_id: 'svc_color_full_bleach', start: '2026-09-18T10:00:00+10:00', end: '2026-09-18T14:00:00+10:00', status: 'confirmed' },
  { appointment_id: 'apt_6005', stylist_id: 'stl_jayden', service_id: 'svc_cut_men',        start: '2026-09-17T10:00:00+10:00', end: '2026-09-17T10:30:00+10:00', status: 'held' },
  // cancelled must NOT block — kept as a live test of the status filter
  { appointment_id: 'apt_6006', stylist_id: 'stl_amy',    service_id: 'svc_blowdry',        start: '2026-09-16T15:00:00+10:00', end: '2026-09-16T15:45:00+10:00', status: 'cancelled' }
]);

const tables = {
  salon_services: {
    columns: [
      ['service_id', 'string'], ['name', 'string'], ['name_zh', 'string'], ['active', 'boolean'],
      ['price', 'number'], ['currency', 'string'], ['duration_min', 'number'],
      ['requires_consult', 'boolean'], ['allowed_stylist_levels', 'string']
    ],
    rows: mock.services.map(s => ({
      service_id: s.id, name: s.name_en, name_zh: s.name_zh, active: true,
      price: s.price_aud, currency: 'AUD', duration_min: s.duration_min,
      requires_consult: !!s.requires_consult, allowed_stylist_levels: J(s.allowed_stylist_levels)
    })).concat([{
      service_id: 'svc_retired_test', name: 'Retired Service (inactive)', name_zh: '已下架测试项', active: false,
      price: 10, currency: 'AUD', duration_min: 10, requires_consult: false, allowed_stylist_levels: '[]'
    }])
  },
  salon_promotions: {
    columns: [
      ['promotion_id', 'string'], ['title', 'string'], ['title_zh', 'string'], ['active', 'boolean'],
      ['valid_from', 'string'], ['valid_to', 'string'], ['channels', 'string'], ['eligibility', 'string'],
      ['discount', 'string']
    ],
    rows: mock.promotions.map(p => ({
      promotion_id: p.id, title: p.title_en, title_zh: p.title_zh, active: true,
      valid_from: p.valid_from, valid_to: p.valid_to, channels: J(p.channels), eligibility: J(p.eligibility),
      discount: J(p.discount || {})
    })).concat([
      // verifiable in the anonymous prototype: everyone=true
      { promotion_id: 'promo_open_all', title: 'Spring Refresh - 10% off any service', title_zh: '春季焕新 全场 9 折',
        active: true, valid_from: '2026-09-01', valid_to: '2026-12-31', channels: J(['web', 'instagram']), eligibility: J({ everyone: true }), discount: J({ type: 'percent', value: 10 }) },
      { promotion_id: 'promo_everyone_cut', title: 'Cut Week - $10 off cuts', title_zh: '剪发周 减 10 元',
        active: true, valid_from: '2026-09-07', valid_to: '2026-09-30', channels: J(['web']),
        eligibility: J({ everyone: true, service_ids: ['svc_cut_women', 'svc_cut_men'] }), discount: J({ type: 'amount', value: 10 }) },
      // everyone=true but EXPIRED: must never surface
      { promotion_id: 'promo_expired_everyone', title: 'EOFY Everyone 25% off', title_zh: '财年末全场 75 折',
        active: true, valid_from: '2026-05-15', valid_to: '2026-06-30', channels: J(['web']), eligibility: J({ everyone: true }), discount: J({ type: 'percent', value: 25 }) }
    ])
  },
  salon_stylists: {
    columns: [
      ['stylist_id', 'string'], ['name', 'string'], ['active', 'boolean'], ['price_tier', 'number'],
      ['specialties', 'string'], ['hair_experience', 'string'], ['languages', 'string']
    ],
    rows: mock.stylists.map(s => ({
      stylist_id: s.id, name: s.name, active: !!s.active, price_tier: tierOf[s.level],
      specialties: J(s.specialties), hair_experience: J(s.texture_experience),
      languages: J([...new Set(s.languages.map(lang))])
    }))
  },
  salon_style_taxonomy: {
    columns: [['taxonomy_id', 'string'], ['name_en', 'string'], ['name_zh', 'string'], ['category', 'string'], ['aliases', 'string']],
    rows: mock.style_taxonomy.map(t => ({
      taxonomy_id: t.id, name_en: t.name_en, name_zh: t.name_zh, category: t.category, aliases: J(aliases[t.id] || [])
    }))
  },

  // --- multi-turn additions -------------------------------------------------
  salon_schedule: {
    columns: [['stylist_id', 'string'], ['weekday', 'number'], ['start_time', 'string'], ['end_time', 'string'],
              ['valid_from', 'string'], ['valid_to', 'string']],
    rows: scheduleRows
  },
  salon_appointments: {
    columns: [['appointment_id', 'string'], ['stylist_id', 'string'], ['service_id', 'string'],
              ['start', 'string'], ['end', 'string'], ['status', 'string']],
    rows: appointmentRows
  },
  // One row per chat session. Written with dataTable `upsert` matching session_id.
  salon_conversations: {
    columns: [['session_id', 'string'], ['status', 'string'], ['slots', 'string'],
              ['recent_turns', 'string'], ['last_question', 'string'],
              ['turn_count', 'number'], ['updated_at', 'string']],
    rows: []
  },

  salon_review_queue: {
    columns: [['session_id', 'string'], ['request_text', 'string'], ['draft_reply', 'string'],
              ['reason', 'string'], ['status', 'string'], ['guardrail_pass', 'boolean'],
              ['auto_sent', 'boolean'], ['slots_snapshot', 'string']],
    rows: []
  }
};

const out = {};
for (const [name, t] of Object.entries(tables)) out[name] = { columns: t.columns.map(([n, type]) => ({ name: n, type })), rows: t.rows };
fs.writeFileSync(path.join(__dirname, 'tables.json'), JSON.stringify(out, null, 2));
for (const [name, t] of Object.entries(out)) console.log(name.padEnd(22), t.columns.length + ' cols', t.rows.length + ' rows');
