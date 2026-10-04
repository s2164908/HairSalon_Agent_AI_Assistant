const { execSync } = require('child_process');
const pnpm = (name) => execSync("find /usr/local/lib/node_modules/n8n/node_modules/.pnpm -maxdepth 1 -name '" + name + "' | head -1").toString().trim();
const U = require(pnpm('undici@*') + '/node_modules/undici');
const { lookup } = require('node:dns');
const fmt = (ms) => String(ms).padStart(5);
async function trial(label, mkAgent, n, fn) {
  let fails = 0; const out = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now(); const d = mkAgent();
    try { await fn(d); out.push(fmt(Date.now() - t)); }
    catch (e) { fails++; const c = (e.cause && (e.cause.code || e.cause.name)) || e.code || e.name; out.push('ERR' + fmt(Date.now() - t) + '(' + c + ')'); }
    finally { await d.close().catch(() => {}); }
  }
  console.log(label.padEnd(46) + ' fails=' + fails + '/' + n + '  ' + out.join(' '));
}
const models = (d) => U.fetch('https://api.openai.com/v1/models', { dispatcher: d, signal: AbortSignal.timeout(12000) }).then(r => r.text());
(async () => {
  console.log('--- A. fresh Agent per request, as n8n does (connect opts vary) ---');
  await trial('default (autoSelectFamily on, 250ms attempts)', () => new U.Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { lookup } }), 10, models);
  await trial('autoSelectFamily: false', () => new U.Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { lookup, autoSelectFamily: false } }), 10, models);
  await trial('autoSelectFamilyAttemptTimeout: 2000ms', () => new U.Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { lookup, autoSelectFamilyAttemptTimeout: 2000 } }), 10, models);
  console.log('--- B. each A record directly (SNI api.openai.com) ---');
  for (const ip of ['172.66.0.243', '162.159.140.245']) {
    await trial('direct ' + ip, () => new U.Agent({ connect: { servername: 'api.openai.com', autoSelectFamily: false, timeout: 10000 } }), 5,
      (d) => U.request('https://' + ip + '/v1/models', { dispatcher: d, headers: { host: 'api.openai.com' }, headersTimeout: 12000 }).then(r => r.body.text()));
  }
  console.log('--- C. does the stack retry a connect timeout? (dummy key: connect OK => 401 fast) ---');
  const OpenAI = require(pnpm('openai@*') + '/node_modules/openai').default;
  await trial('openai SDK maxRetries=2 timeout=60000', () => new U.Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { lookup } }), 6,
    async (d) => { const c = new OpenAI({ apiKey: 'sk-dummy', maxRetries: 2, timeout: 60000, fetchOptions: { dispatcher: d } });
      try { await c.models.list(); } catch (e) { if (e.status === 401) return; throw e; } });
  const { ChatOpenAI } = require(pnpm('@langchain+openai@*') + '/node_modules/@langchain/openai');
  await trial('LangChain ChatOpenAI maxRetries=2 timeout=60000', () => new U.Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { lookup } }), 6,
    async (d) => { const m = new ChatOpenAI({ apiKey: 'sk-dummy', model: 'gpt-4o-mini', maxRetries: 2, timeout: 60000, configuration: { fetchOptions: { dispatcher: d } } });
      try { await m.invoke('hi'); } catch (e) { if (e.status === 401 || /401|Incorrect API key/i.test(String(e.message))) return; throw e; } });
})().catch(e => { console.log('FATAL', e); process.exit(1); });
