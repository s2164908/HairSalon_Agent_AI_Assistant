// Serves the built workflow and the table fixtures to the in-app browser so the
// deploy script can read them instead of retyping tens of KB. Localhost only.
const http = require('http'), fs = require('fs'), path = require('path');
const FILES = {
  '/salon-assistant-v2.json': path.join(__dirname, '..', 'salon-assistant-v2.json'),
  '/tables.json': path.join(__dirname, 'tables.json')
};
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const f = FILES[req.url.split('?')[0]];
  if (!f) { res.writeHead(404, cors); return res.end('not found'); }
  res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
  fs.createReadStream(f).pipe(res);
}).listen(8765, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8765'));
