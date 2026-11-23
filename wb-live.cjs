const http = require('node:http');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const net = require('node:net');
const { planSupplies } = require('./wb-supplies.cjs');

const host = '127.0.0.1';
const port = 8080;
const origin = 'http://127.0.0.1:8080';
const page = fs.readFileSync(path.join(__dirname, 'WB-FBS-live.html'));
const windows = process.env.SystemRoot || 'C:\Windows';
const ssh = path.join(windows, 'System32', 'OpenSSH', 'ssh.exe');
const powershell = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const stateFile = path.join(process.env.LOCALAPPDATA || homedir(), 'WB-FBS-Panel', 'shops.dpapi');
const identity = path.join(homedir(), '.ssh', 'wb-panel-hk-ed25519');
const vdsConfigPath = path.join(__dirname, 'vds.local.json');
if (!fs.existsSync(vdsConfigPath)) throw new Error('Copy vds.example.json to vds.local.json and set your SSH connection details.');
const vds = JSON.parse(fs.readFileSync(vdsConfigPath, 'utf8').replace(/^\uFEFF/, ''));
if (!/^[\w.-]+$/.test(vds.host) || !/^[\w-]+$/.test(vds.user) ||
    !Number.isInteger(vds.port) || vds.port < 1 || vds.port > 65535) throw new Error('Invalid vds.local.json');
const destination = vds.user + '@' + vds.host;
const routes = {
  orders: ['GET', 'https://marketplace-api.wildberries.ru/api/v3/orders/new'],
  cards: ['POST', 'https://content-api.wildberries.ru/content/v2/get/cards/list'],
};

function protect(mode, input) {
  const command = mode === 'encrypt'
    ? '$bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)))'
    : '$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)))';
  const setup = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'); " +
    '$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; ';
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    setup + command],
  { input, encoding: 'utf8', windowsHide: true, timeout: 10000 }).replace(/^\uFEFF/, '').trim();
}

function loadShops() {
  let encrypted;
  try {
    encrypted = fs.readFileSync(stateFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return JSON.parse(protect('decrypt', encrypted));
}

let shops = loadShops();
const snapshots = new Map();
const catalogs = new Map();
const pending = new Map();
const photos = new Map();
let exchange = null;
let rateCheck = 0;

function sshRun(command, input, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    const child = execFile(ssh, ['-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
      '-i', identity, '-p', String(vds.port), destination, command],
    { timeout: 42000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const hkGate = [
  "geo=$(curl --noproxy '*' -4 -fsS --max-time 10 https://ipinfo.io/json) || exit 31",
  "country=$(printf '%s' \"$geo\" | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"country\"])') || exit 31",
  '[ "$country" = HK ] || exit 32',
].join('\n');

function testTcp() {
  return new Promise(resolve => {
    const start = performance.now();
    const socket = net.connect({ host: vds.host, port: vds.port });
    const end = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(5000, () => end(null));
    socket.once('error', () => end(null));
    socket.once('connect', () => end(Math.round(performance.now() - start)));
  });
}

async function testVds() {
  const start = performance.now();
  const ping = new Promise(resolve => {
    execFile(path.join(windows, 'System32', 'PING.EXE'), ['-4', '-n', '3', '-w', '1000', vds.host],
      { timeout: 5000, windowsHide: true }, (_error, stdout) => {
        const samples = [...(stdout || '').matchAll(/[=<]\s*(\d+)[^\d\s]{0,4}\s+TTL=/gi)].map(match => Number(match[1]));
        resolve(samples.length > 0 ? { samples: samples.slice(0, 3) } : { samples: [] });
      });
  });
  const remote = sshRun("printf 'ready\\n'; curl --noproxy '*' -4 -fsS --max-time 10 https://ipinfo.io/json || true; printf '\\n--wb--\\n'; curl --noproxy '*' -4 -sS -o /dev/null --max-time 10 --write-out '%{http_code} %{time_total}' https://marketplace-api.wildberries.ru/ping || true")
    .then(stdout => ({ stdout, sshMs: Math.round(performance.now() - start) }))
    .catch(() => ({ stdout: '', sshMs: null }));
  const [tcpMs, icmp, result] = await Promise.all([testTcp(), ping, remote]);
  const [rawGeo, rawWB] = result.stdout.replace(/^ready\r?\n/, '').split('\n--wb--\n');
  let geo = null;
  try {
    const { ip, city, region, country, org, timezone, loc, hostname } = JSON.parse(rawGeo);
    geo = { ip, city, region, country, org, timezone, loc, hostname };
  } catch {}
  const [status, time] = (rawWB || '').trim().split(/\s+/);
  const wb = /^\d{3}$/.test(status) && status !== '000' ? { status, ms: Math.round(Number(time) * 1000) } : null;
  return { host: vds.host, port: vds.port, tcpMs, icmp, sshMs: result.sshMs, geo, wb, checkedAt: new Date().toISOString() };
}

async function refreshRate() {
  if (Date.now() < rateCheck) return;
  rateCheck = Date.now() + 5 * 60 * 1000;
  try {
    const response = await fetch('https://www.cbr.ru/scripts/XML_daily.asp', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    const xml = Buffer.from(await response.arrayBuffer()).toString('latin1');
    const cny = [...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)]
      .map(match => match[1]).find(value => /<CharCode>CNY<\/CharCode>/.test(value));
    if (!cny) return;
    const nominal = Number(cny.match(/<Nominal>([\d.]+)<\/Nominal>/)?.[1]);
    const rubPerCny = Number(cny.match(/<Value>([\d,.]+)<\/Value>/)?.[1]?.replace(',', '.')) / nominal;
    const date = xml.match(/<ValCurs\b[^>]*\bDate="([\d.]+)"/)?.[1];
    if (!Number.isFinite(rubPerCny) || rubPerCny <= 0 || !date) return;
    exchange = { rubPerCny, date };
    rateCheck = Date.now() + 60 * 60 * 1000;
  } catch {}
}

function saveShops(next) {
  const encrypted = protect('encrypt', JSON.stringify(next));
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = stateFile + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, encrypted, { flag: 'wx' });
    fs.renameSync(temporary, stateFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  shops = next;
}

async function queryWB(route, token, body) {
  const [method, url] = routes[route];
  const remote = hkGate + "\nexec curl --noproxy '*' -4 -sS --proto '=https' --max-time 20 --request " + method +
    " --config - --write-out '\\n%{http_code}' " + url;
  const config = ['header = ' + JSON.stringify('Authorization: ' + token)];
  if (body) config.push('header = "Content-Type: application/json"', 'data = ' + JSON.stringify(JSON.stringify(body)));
  let stdout;
  try {
    stdout = await sshRun(remote, config.join('\n') + '\n');
  } catch (error) {
    if (error.code === 31) throw new Error('VDS не смог проверить геолокацию IPv4.');
    if (error.code === 32) throw new Error('Исходящий IPv4 VDS определяется вне Гонконга.');
    throw new Error('Не удалось получить ответ через VDS. Проверь SSH и доступность WB.');
  }
  const boundary = stdout.lastIndexOf('\n');
  const status = stdout.slice(boundary + 1).trim();
  if (status !== '200') {
    const code = /^\d{3}$/.test(status) ? status : 'неизвестен';
    throw Object.assign(new Error('WB вернул HTTP ' + code + '.'), { status });
  }
  try { return JSON.parse(stdout.slice(0, boundary)); } catch { throw new Error('Ответ WB не удалось прочитать.'); }
}

function productPhoto(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\/(?:[a-z0-9_./-]+)\.(webp|jpe?g|png)$/i.test(value)) return '';
  const url = new URL(value);
  if (!/(^|\.)(wbbasket\.ru|wbstatic\.net|wb\.ru)$/i.test(url.hostname)) return '';
  const id = createHash('sha256').update(value).digest('hex').slice(0, 24);
  if (!photos.has(id)) {
    if (photos.size >= 1000) photos.delete(photos.keys().next().value);
    photos.set(id, { url: value });
  }
  return '/api/photo/' + id;
}

async function servePhoto(response, entry) {
  try {
    entry.data ??= sshRun(hkGate + "\nexec curl --noproxy '*' -4 -fsS --proto '=https' --max-time 12 --max-filesize 700000 " + entry.url, '', 'buffer')
      .catch(error => { delete entry.data; throw error; });
    const data = await entry.data;
    const contentType = entry.url.endsWith('.webp') ? 'image/webp' : entry.url.endsWith('.png') ? 'image/png' : 'image/jpeg';
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
}

async function productTitles(shop, orders) {
  let catalog = catalogs.get(shop.id);
  if (!catalog || Date.now() - catalog.created > 15 * 60 * 1000) {
    catalog = { created: Date.now(), titles: new Map(), cursor: { limit: 100 }, done: false };
    catalogs.set(shop.id, catalog);
  }
  const wanted = new Set(orders.map(order => order.nmId).filter(Boolean));
  for (const id of catalog.titles.keys()) wanted.delete(id);
  while (wanted.size && !catalog.done) {
    const { cards, cursor } = await queryWB('cards', shop.contentToken || shop.token, {
      settings: { cursor: catalog.cursor, filter: { withPhoto: -1 } },
    });
    if (!Array.isArray(cards) || !Number.isInteger(cursor?.total)) throw new Error('Ответ каталога WB неполный.');
    for (const card of cards) {
      if (typeof card.title === 'string' && card.title.trim()) {
        catalog.titles.set(String(card.nmID), { title: card.title, photo: productPhoto(card.photos?.[0]?.c246x328 || card.photos?.[0]?.square) });
        wanted.delete(String(card.nmID));
      }
    }
    catalog.done = cursor.total < 100;
    if (!catalog.done) {
      if (!cursor.updatedAt || !cursor.nmID || (catalog.cursor.nmID === cursor.nmID &&
          catalog.cursor.updatedAt === cursor.updatedAt)) throw new Error('Каталог WB повторил страницу.');
      catalog.cursor = { limit: 100, updatedAt: cursor.updatedAt, nmID: cursor.nmID };
      if (wanted.size) await new Promise(resolve => setTimeout(resolve, 650));
    }
  }
  return catalog.titles;
}

function refresh(shop) {
  if (pending.has(shop.id)) return pending.get(shop.id);
  const job = (async () => {
    let orders;
    try {
      const result = await queryWB('orders', shop.token);
      orders = result.orders.map(({ id, nmId, article, warehouseId, createdAt, price, currencyCode,
        convertedPrice, convertedCurrencyCode, cargoType, crossBorderType, isB2b }) => ({
        id: String(id), nmId: nmId == null ? '' : String(nmId), article, warehouseId, createdAt,
        price, currencyCode, convertedPrice, convertedCurrencyCode, cargoType, crossBorderType, isB2b,
      }));
    } catch (error) {
      const previous = snapshots.get(shop.id);
      snapshots.set(shop.id, { ...previous, error: error.message });
      return;
    }

    const previous = snapshots.get(shop.id);
    const updatedAt = new Date().toISOString();
    const cached = new Map((previous?.orders || []).filter(order => order.title).map(({ nmId, title, photo }) => [nmId, { title, photo }]));
    orders = orders.map(order => ({ ...order, ...cached.get(order.nmId) }));
    snapshots.set(shop.id, { orders, updatedAt, error: '', loadingTitles: true });

    let titleError = '';
    try {
      const titles = await productTitles(shop, orders);
      orders = orders.map(order => ({ ...order, ...titles.get(order.nmId) }));
    } catch (error) {
      const titles = catalogs.get(shop.id)?.titles;
      orders = orders.map(order => ({ ...order, ...titles?.get(order.nmId) }));
      titleError = ['401', '403'].includes(error.status)
        ? 'Для названий добавь токен с доступом к категории «Контент».'
        : 'Каталог WB не загрузился. ' + error.message;
    }
    snapshots.set(shop.id, { orders, updatedAt, error: '', titleError });
  })().finally(() => pending.delete(shop.id));
  pending.set(shop.id, job);
  return job;
}

function publicState() {
  return { exchange, shops: shops.map(({ id, name, contentToken }) => ({
    id, name, hasContentToken: Boolean(contentToken), busy: pending.has(id), ...snapshots.get(id),
  })) };
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readInput(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    const limit = request.url === '/api/plan' ? 4 * 1024 * 1024 : 12000;
    if (body.length > limit) throw new Error('Запрос слишком большой.');
  }
  return JSON.parse(body);
}

const validToken = token => typeof token === 'string' && /^[A-Za-z0-9._~-]{1,4096}$/.test(token);
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'");
  if (request.headers.host !== host + ':' + port) return json(response, 403, { error: 'Открой панель по адресу ' + origin });
  if (request.method === 'GET' && request.url === '/liquidglass-v1.0.3.mjs') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return response.end(fs.readFileSync(path.join(__dirname, 'liquidglass-v1.0.3.mjs')));
  }
  if (request.method === 'GET' && ['/', '/assembly', '/shops', '/vds', '/supplies'].includes(request.url)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(page);
  }
  if (request.method === 'GET' && request.url === '/api/state') return json(response, 200, publicState());
  if (request.method === 'GET' && request.url.startsWith('/api/photo/')) {
    const entry = photos.get(request.url.slice('/api/photo/'.length));
    return entry ? servePhoto(response, entry) : response.writeHead(404).end();
  }
  if (request.method !== 'POST') return json(response, 404, { error: 'Страница не найдена.' });
  if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
    return json(response, 403, { error: 'Запрос разрешён только из локальной панели.' });
  }
  let input;
  try {
    input = await readInput(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  } catch {
    return json(response, 400, { error: 'Не удалось прочитать запрос.' });
  }
  const existing = shops.find(shop => shop.id === input.id);
  if (request.url === '/api/vds') return json(response, 200, await testVds());
  if (request.url === '/api/plan') {
    if (!Array.isArray(input.keys) || input.keys.some(key => typeof key !== 'string')) {
      return json(response, 400, { error: 'Проверь выбранные заказы.' });
    }
    return json(response, 200, planSupplies(publicState().shops, input.keys));
  }
  if (request.url === '/api/refresh') {
    if (input.id && !existing) return json(response, 404, { error: 'Магазин не найден.' });
    for (const shop of existing ? [existing] : shops) void refresh(shop);
    void refreshRate();
    return json(response, 202, publicState());
  }
  if (!['/api/shop', '/api/remove'].includes(request.url)) return json(response, 404, { error: 'Страница не найдена.' });
  if (input.id && !existing || request.url === '/api/remove' && !existing) {
    return json(response, 404, { error: 'Магазин не найден.' });
  }
  if (existing && pending.has(existing.id)) return json(response, 409, { error: 'Дождись обновления магазина.' });
  try {
    if (request.url === '/api/remove') {
      saveShops(shops.filter(shop => shop !== existing));
      snapshots.delete(existing.id);
      catalogs.delete(existing.id);
    } else {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const token = input.token || existing?.token;
      const contentToken = input.clearContentToken ? '' : input.contentToken || existing?.contentToken || '';
      if (!name || name.length > 80 || !validToken(token) || contentToken && !validToken(contentToken)) {
        return json(response, 400, { error: 'Проверь название и API-токены магазина.' });
      }
      if (shops.some(shop => shop !== existing && (shop.token === token || shop.name.toLowerCase() === name.toLowerCase()))) {
        return json(response, 409, { error: 'Магазин с этим названием или токеном уже добавлен.' });
      }
      const shop = { id: existing?.id || randomUUID(), name, token, contentToken };
      saveShops(existing ? shops.map(item => item === existing ? shop : item) : [...shops, shop]);
      snapshots.delete(shop.id);
      catalogs.delete(shop.id);
      void refresh(shop);
    }
    return json(response, 200, publicState());
  } catch {
    return json(response, 500, { error: 'Windows не смогла сохранить настройки магазина.' });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Порт 8080 уже занят.' : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log('Панель WB открыта по адресу ' + origin);
  for (const shop of shops) void refresh(shop);
  void refreshRate();
});

