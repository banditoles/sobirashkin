const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const host = '127.0.0.1';
const port = 8081;
const page = path.join(__dirname, 'WB-FBS-live.html');
const now = Date.now();
const orders = ['Беспроводная мышь', 'Коврик для мыши', 'Подставка для ноутбука'].map((title, index) => ({
  id: String(70001 + index), title, article: 'Демо-' + (index + 1), warehouseId: 1,
  price: (1290 + index * 490) * 100, currencyCode: 643,
  createdAt: new Date(now - (index + 1) * 45 * 60000).toISOString(),
}));
const state = JSON.stringify({ exchange: null, shops: [
  { id: 'demo', name: 'Демо-магазин', orders, updatedAt: new Date(now).toISOString() },
] });

http.createServer((request, response) => {
  if (request.headers.host !== host + ':' + port || request.method !== 'GET') {
    response.writeHead(405).end();
  } else if (request.url === '/liquidglass-v1.0.3.mjs') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(fs.readFileSync(path.join(__dirname, 'liquidglass-v1.0.3.mjs')));
  } else if (request.url === '/api/state') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(state);
  } else if (['/', '/assembly'].includes(request.url)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(fs.readFileSync(page));
  } else {
    response.writeHead(404).end('Preview pages: / and /assembly');
  }
}).listen(port, host, () => console.log('Design preview: http://' + host + ':' + port));

