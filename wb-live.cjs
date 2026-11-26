const http = require('node:http');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const net = require('node:net');
const { planSupplies, listSuppliesCall, supplyOrderIdsCall, writeCalls } = require('./wb-supplies.cjs');
const { imeiTemplate, readOrderImeis } = require('./wb-imei-template.cjs');

const host = '127.0.0.1';
if (process.argv.includes('--training')) {
  console.error('Тренировочная панель удалена. Рабочая панель не запущена.');
  process.exit(1);
}
const port = 8080;
const origin = 'http://' + host + ':' + port;
const page = fs.readFileSync(path.join(__dirname, 'WB-FBS-live.html'));
const mac = process.platform === 'darwin';
const windows = process.env.SystemRoot || 'C:\\Windows';
const ssh = mac ? '/usr/bin/ssh' : path.join(windows, 'System32', 'OpenSSH', 'ssh.exe');
const powershell = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const stateFile = path.join(process.env.LOCALAPPDATA || homedir(), 'WB-FBS-Panel', 'shops.dpapi');
const catalogDir = path.join(mac ? path.join(homedir(), 'Library', 'Caches') : path.dirname(path.dirname(stateFile)),
  'WB-FBS-Panel', 'catalog');

const vdsConfigPath = path.join(__dirname, 'vds.local.json');
const vdsConfig = fs.existsSync(vdsConfigPath)
  ? JSON.parse(fs.readFileSync(vdsConfigPath, 'utf8').replace(/^\uFEFF/, ''))
  : null;
const vds = vdsConfig?.user === '' ? null : vdsConfig;
if (vds && (typeof vds.host !== 'string' || !/^[a-z0-9][\w.-]*$/i.test(vds.host) ||
    typeof vds.user !== 'string' || !/^[\w-]+$/.test(vds.user) ||
    !Number.isInteger(vds.port) || vds.port < 1 || vds.port > 65535)) {
  throw new Error('Проверь host, user и port в vds.local.json.');
}
const identity = path.join(homedir(), '.ssh', 'wb-panel-hk-ed25519');
const destination = vds ? vds.user + '@' + vds.host : null;
const vdsMissing = 'Заполни host, port и SSH-пользователя (user) в vds.local.json и перезапусти панель.';
const routes = {
  orders: ['GET', 'https://marketplace-api.wildberries.ru/api/v3/orders/new'],
  cards: ['POST', 'https://content-api.wildberries.ru/content/v2/get/cards/list'],
  stickers: ['POST', 'https://marketplace-api.wildberries.ru/api/v3/orders/stickers?type=png&width=58&height=40'],
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

function keychain(operation, input) {
  try {
    return execFileSync('/usr/bin/swift', [path.join(__dirname, 'wb-keychain.swift'), operation],
      { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (operation === 'read' && error.status === 44) return null;
    const status = error.stderr?.match(/Keychain OSStatus (-?\d+)/)?.[1];
    const detail = status ? 'Код macOS: ' + status + '.' : error.code === 'ETIMEDOUT'
      ? 'Не дождался ответа macOS. Проверь, не открыто ли окно запроса доступа.'
      : 'Не удалось запустить помощник Swift. Проверь установку Xcode Command Line Tools.';
    const failure = new Error('Не удалось ' + (operation === 'read' ? 'прочитать' : 'сохранить') +
      ' магазины в Связке ключей. ' + detail);
    failure.keychain = true;
    throw failure;
  }
}

function loadShops() {
  if (mac) return JSON.parse(keychain('read') ?? '[]');
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
const seenSupplies = new Map();
const seenSupplyOrders = new Map();
const recentOrders = new Map();
const orderHistory = new Map();
const catalogReads = new Map();
const stickerCaches = new Map();
const stickerReads = new Map();
const supplyLists = new Map();
const supplyMemberships = new Map();

function runtimeCacheFile(shopId, name) {
  const scope = createHash('sha256').update(shopId).digest('hex');
  return path.join(catalogDir, '..', 'runtime', scope, name + '.json');
}

function readRuntimeCache(file, token) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.scope === createHash('sha256').update(token).digest('hex')) return record;
  } catch {}
  return null;
}

function saveRuntimeCache(file, token, until, value) {
  try {
    writeLocalFile(file, JSON.stringify({ scope: createHash('sha256').update(token).digest('hex'), until, value }));
  } catch {}
}

function cachedSupplyRead(cache, key, token, read, ttl = 60000, file, fresh = false) {
  const previous = cache.get(key);
  if (!fresh && previous?.token === token && (previous.pending || previous.until > Date.now())) return previous.result;
  if (!previous && !fresh && file) {
    const stored = readRuntimeCache(file, token);
    if (stored?.until > Date.now() && Array.isArray(stored.value)) {
      const result = Promise.resolve(stored.value);
      cache.set(key, { token, until: stored.until, result });
      return result;
    }
  }
  const entry = { token, pending: true };
  cache.set(key, entry);
  entry.result = read().then(value => {
    entry.pending = false;
    entry.until = Date.now() + ttl;
    if (file && cache.get(key) === entry) saveRuntimeCache(file, token, entry.until, value);
    return value;
  }, error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  return entry.result;
}
let submittingSupply = false;
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
    const binary = mac ? '/sbin/ping' : path.join(windows, 'System32', 'PING.EXE');
    const args = mac ? ['-n', '-c', '3', '-W', '1000', vds.host] : ['-4', '-n', '3', '-w', '1000', vds.host];
    execFile(binary, args,
      { timeout: 5000, windowsHide: true }, (_error, stdout) => {
        const pattern = mac ? /time[=<]\s*(\d+(?:\.\d+)?)\s*ms/gi : /[=<]\s*(\d+)[^\d\s]{0,4}\s+TTL=/gi;
        const samples = [...(stdout || '').matchAll(pattern)].map(match => Math.round(Number(match[1])));
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

function writeLocalFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function saveShops(next) {
  if (mac) {
    keychain('write', JSON.stringify(next));
    shops = next;
    return;
  }
  const encrypted = protect('encrypt', JSON.stringify(next));
  writeLocalFile(stateFile, encrypted);
  shops = next;
}

async function queryWB(route, token, body) {
  const [method, url] = routes[route];
  return callWB({ method, url, body, expected: 200 }, token);
}

function splitWBResponse(raw) {
  let payload = raw;
  let headers = new Map();
  while (/^HTTP\/\S+ \d{3}\b/.test(payload)) {
    const boundary = /\r?\n\r?\n/.exec(payload);
    if (!boundary) break;
    headers = new Map();
    for (const line of payload.slice(0, boundary.index).split(/\r?\n/).slice(1)) {
      const separator = line.indexOf(':');
      if (separator > 0) headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
    }
    payload = payload.slice(boundary.index + boundary[0].length);
  }
  return { payload, headers };
}

function wbError(status, payload, headers, token) {
  const hints = {
    400: 'WB не принял параметры запроса.',
    401: 'Проверь, не истёк ли токен и правильно ли он введён.',
    402: 'WB требует оплату для этого метода.',
    403: 'Проверь категорию и права токена.',
    404: 'Ресурс не найден в WB.',
    409: 'Операция конфликтует с текущим состоянием данных в WB.',
    413: 'Слишком большой запрос. Уменьши число элементов.',
    422: 'WB не смог обработать параметры запроса.',
    429: 'Превышен лимит запросов WB.',
  };
  const parts = ['WB вернул HTTP ' + status + '.', hints[status] || (/^5\d\d$/.test(status) ? 'Сервис WB временно недоступен.' : '')];
  if (status === '429') {
    const number = name => {
      const value = headers.get(name);
      return /^\d{1,9}$/.test(value ?? '') ? Number(value) : null;
    };
    const retry = number('x-ratelimit-retry') ?? number('retry-after');
    const reset = number('x-ratelimit-reset');
    const limit = number('x-ratelimit-limit');
    parts.push(retry == null ? 'WB не указал время повтора.' : 'Повтор через ' + retry + ' сек.');
    if (limit != null) parts.push('Максимум подряд: ' + limit + ' запросов.');
    if (reset != null) parts.push('Полное восстановление лимита через ' + reset + ' сек.');
  }
  try {
    const data = JSON.parse(payload);
    const detail = [data?.detail, data?.details, data?.message, data?.errorText, data?.title]
      .find(value => typeof value === 'string' && value.trim());
    if (detail) parts.push('Подробности WB: ' + detail.split(token).join('[скрыто]').replace(/\s+/g, ' ').trim().slice(0, 500));
    const trace = data?.requestId;
    if (typeof trace === 'string' && /^[a-z0-9_-]{8,100}$/i.test(trace) && !trace.includes(token)) {
      parts.push('ID запроса: ' + trace + '.');
    }
  } catch {}
  return Object.assign(new Error(parts.filter(Boolean).join(' ')), { status });
}

async function callWB({ method, url, body, expected }, token) {
  if (!vds) throw new Error(vdsMissing);
  const remote = hkGate + "\nexec curl --noproxy '*' -4 -sS --proto '=https' --max-time 20 --request " + method +
    " --config - --dump-header - --write-out '\\n%{http_code}' " + "'" + url + "'";
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
  const { headers, payload } = splitWBResponse(stdout.slice(0, boundary));
  if (status !== String(expected)) {
    if (!/^\d{3}$/.test(status)) throw new Error('Не удалось определить HTTP-статус ответа WB.');
    throw wbError(status, payload, headers, token);
  }
  if (expected === 204) return;
  try { return JSON.parse(payload); } catch { throw new Error('Ответ WB не удалось прочитать.'); }
}

async function listSupplies(shop, fresh = false) {
  const supplies = await cachedSupplyRead(supplyLists, shop.id, shop.token, () => fetchSupplies(shop),
    300000, runtimeCacheFile(shop.id, 'supplies'), fresh);
  seenSupplies.set(shop.id, { token: shop.token, supplies });
  return supplies;
}

async function fetchSupplies(shop) {
  const supplies = [];
  const seen = new Set();
  let next = 0;
  do {
    if (seen.has(next)) throw new Error('WB повторил страницу поставок.');
    seen.add(next);
    const page = await callWB(listSuppliesCall(next), shop.token);
    if (!Array.isArray(page?.supplies)) throw new Error('WB вернул неполный список поставок.');
    supplies.push(...page.supplies);
    next = page.supplies.length ? page.next : 0;
    if (next) await new Promise(resolve => setTimeout(resolve, 220));
  } while (next);
  return supplies;
}

function supplyLink(shop, group, legacy = false) {
  const key = legacy ? [shop.id, group.displayName] :
    [shop.id, group.warehouseId, group.cargoType, group.crossBorderType, group.isB2b];
  const fingerprint = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  return path.join(catalogDir, '..', 'supply-links', fingerprint);
}

function knownSupplies(link) {
  try { return fs.readFileSync(link, 'utf8').trim().split(/\s+/); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}

function canUseSupply(group, supply, known, empty) {
  return supply.done === false && (empty || (
    (known.includes(supply.id) || supply.name === group.displayName) &&
    supply.cargoType === group.cargoType && supply.crossBorderType === group.crossBorderType && supply.isB2b === group.isB2b));
}

function supplyChoices(group) {
  const shop = shops.find(item => item.id === group.shopId);
  if (!shop || group.incomplete || group.stale) return [];
  const list = seenSupplies.get(shop.id);
  if (list?.token !== shop.token) return [];
  const composition = seenSupplyOrders.get(shop.id);
  const known = [...knownSupplies(supplyLink(shop, group)), ...knownSupplies(supplyLink(shop, group, true))];
  return list.supplies.filter(supply => canUseSupply(group, supply, known,
    composition?.token === shop.token && composition.members.get(supply.id)?.length === 0))
    .map(({ id, name }) => ({ id, name }));
}

async function submitSupply(shop, keys, confirmedName, destinationId) {
  const { orders } = await queryWB('orders', shop.token);
  const fresh = orders.map(order => ({ ...order, id: String(order.id) }));
  const { groups, missing } = planSupplies([{ ...shop, orders: fresh }], keys);
  if (missing.length || groups.length !== 1 || groups[0].incomplete || groups[0].displayName !== confirmedName) {
    throw new Error('Состав группы изменился или несовместим. Обнови заказы и выбери их заново.');
  }
  const group = groups[0];
  const link = supplyLink(shop, group);
  const known = [...new Set([...knownSupplies(link), ...knownSupplies(supplyLink(shop, group, true))])];
  const candidates = [];
  if (destinationId) {
    await new Promise(resolve => setTimeout(resolve, 220));
    const candidate = (await listSupplies(shop, true)).find(supply => supply.id === destinationId && supply.done === false);
    if (!candidate) throw new Error('Выбранная поставка закрыта или не найдена.');
    await new Promise(resolve => setTimeout(resolve, 220));
    const result = await callWB(supplyOrderIdsCall(candidate.id), shop.token);
    if (!Array.isArray(result?.orderIds)) throw new Error('WB не вернул состав открытой поставки.');
    candidate.empty = result.orderIds.length === 0;
    if (!canUseSupply(group, candidate, known, candidate.empty)) {
      throw new Error('Не удалось подтвердить склад или совместимость выбранной поставки.');
    }
    candidates.push(candidate);
    const queued = new Set(result.orderIds.map(String));
    group.orderIds = group.orderIds.filter(id => !queued.has(id));
    if (!group.orderIds.length) return candidate.id;
  }
  const calls = writeCalls(group, candidates);
  await new Promise(resolve => setTimeout(resolve, 220));
  const supplyId = calls.supplyId || (await callWB(calls.create, shop.token))?.id;
  const batches = calls.append(supplyId);
  try {
    for (const call of batches) {
      await new Promise(resolve => setTimeout(resolve, 220));
      await callWB(call, shop.token);
    }
  } finally {
    supplyLists.delete(shop.id);
    supplyMemberships.delete(shop.id + '/' + supplyId);
    for (const name of ['supplies', 'members-' + supplyId, 'orders']) {
      try { fs.rmSync(runtimeCacheFile(shop.id, name), { force: true }); } catch {}
    }
  }
  if (!known.includes(supplyId)) {
    const confirmed = [...known, supplyId];
    try {
      writeLocalFile(link, confirmed.join('\n'));
    } catch { console.warn('Не удалось сохранить связь поставки со складом.'); }
  }
  return supplyId;
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

function catalogFile(shop) {
  return path.join(catalogDir, createHash('sha256').update(shop.id).digest('hex') + '.json');
}

function catalogFor(shop) {
  let catalog = catalogs.get(shop.id);
  if (!catalog) {
    const titles = new Map();
    try {
      const cards = JSON.parse(fs.readFileSync(catalogFile(shop), 'utf8'));
      for (const [id, card] of Object.entries(cards)) {
        if (/^\d+$/.test(id) && typeof card?.title === 'string') titles.set(id, card);
      }
    } catch {}
    catalog = { created: 0, titles, cursor: { limit: 100 }, done: false };
    catalogs.set(shop.id, catalog);
  }
  return catalog;
}

function clearCatalog(shop) {
  recentOrders.delete(shop.id);
  orderHistory.delete(shop.id);
  stickerCaches.delete(shop.id);
  supplyLists.delete(shop.id);
  seenSupplies.delete(shop.id);
  seenSupplyOrders.delete(shop.id);
  for (const key of supplyMemberships.keys()) if (key.startsWith(shop.id + '/')) supplyMemberships.delete(key);
  try { fs.rmSync(path.dirname(runtimeCacheFile(shop.id, 'orders')), { recursive: true, force: true }); } catch {}
  catalogs.delete(shop.id);
  try { fs.rmSync(catalogFile(shop), { force: true }); } catch {}
  try { fs.rmSync(orderIndexFile(shop), { force: true }); } catch {}
}

function orderIndexFile(shop) {
  return catalogFile(shop).replace(/\.json$/, '-orders.json');
}

function orderIndex(shop) {
  let saved = recentOrders.get(shop.id);
  if (saved?.token !== shop.token) {
    const orders = new Map();
    const scope = createHash('sha256').update(shop.token).digest('hex');
    try {
      const stored = JSON.parse(fs.readFileSync(orderIndexFile(shop), 'utf8'));
      if (stored.scope === scope) {
        for (const [id, order] of Object.entries(stored.orders)) orders.set(id, order);
      }
    } catch {}
    saved = { token: shop.token, orders, scope };
    recentOrders.set(shop.id, saved);
  }
  return saved;
}

function orderPriceFields(order) {
  return Object.fromEntries(['price', 'currencyCode', 'convertedPrice', 'convertedCurrencyCode']
    .filter(field => Number.isFinite(order[field])).map(field => [field, order[field]]));
}

function rememberOrders(shop, orders) {
  if (!orders.length) return;
  const index = orderIndex(shop);
  for (const order of orders) {
    const { id, nmId, title, article } = order;
    const older = index.orders.get(String(id));
    index.orders.delete(String(id));
    index.orders.set(String(id), { ...orderPriceFields(older || {}), ...orderPriceFields(order),
      nmId: nmId == null ? older?.nmId : String(nmId), title: title || older?.title, article: article || older?.article });
  }
  while (index.orders.size > 5000) index.orders.delete(index.orders.keys().next().value);
  try { writeLocalFile(orderIndexFile(shop), JSON.stringify({ scope: index.scope, orders: Object.fromEntries(index.orders) })); }
  catch { console.warn('Не удалось сохранить локальный индекс названий заказов.'); }
}

async function fetchOrderHistory(shop) {
  const orders = new Map();
  let next = 0;
  const seen = new Set();
  for (let page = 0; page < 4; page++) {
    if (!Number.isSafeInteger(next) || next < 0 || seen.has(next)) break;
    seen.add(next);
    const result = await callWB({ method: 'GET', expected: 200,
      url: 'https://marketplace-api.wildberries.ru/api/v3/orders?limit=1000&next=' + next }, shop.token);
    if (!Array.isArray(result?.orders)) throw new Error('WB не вернул историю заказов.');
    for (const order of result.orders) {
      const { id, nmId, article } = order;
      if (id != null) orders.set(String(id), { id: String(id), nmId, article, ...orderPriceFields(order) });
    }
    if (!result.next || !result.orders.length) break;
    next = result.next;
    await new Promise(resolve => setTimeout(resolve, 220));
  }
  return orders;
}

async function supplyProducts(shop, ids, { includePrices = true } = {}) {
  const index = orderIndex(shop).orders;
  const requested = [...new Set(ids.map(String))];
  const missing = requested.filter(id => {
    const order = index.get(id);
    return !order || (includePrices && !Number.isFinite(order.price) && !Number.isFinite(order.convertedPrice));
  });
  let warning = '';
  if (missing.length) {
    try {
      const history = await cachedSupplyRead(orderHistory, shop.id, shop.token, () => fetchOrderHistory(shop), 300000);
      rememberOrders(shop, missing.map(id => history.get(id)).filter(Boolean));
    } catch (error) { warning = 'Не удалось загрузить товары из истории: ' + error.message; }
  }
  const catalog = catalogFor(shop);
  const records = requested.map(id => ({ id, ...index.get(id) }));
  const withoutTitle = records.filter(order => order.nmId && !order.title && !catalog.titles.has(order.nmId));
  if (withoutTitle.length) {
    try { await productTitles(shop, withoutTitle); }
    catch (error) { warning ||= 'Не удалось загрузить названия из каталога: ' + error.message; }
  }
  const items = new Map(records.map(order => [order.id, {
    id: order.id, article: order.article, title: catalog.titles.get(order.nmId)?.title || order.title,
    ...orderPriceFields(order),
  }]));
  return { items, warning };
}

function withCatalog(orders, catalog) {
  return orders.map(order => {
    const card = catalog.titles.get(order.nmId);
    return card ? { ...order, title: card.title, photo: productPhoto(card.photoUrl) } : order;
  });
}

function productTitles(shop, orders) {
  const previous = catalogReads.get(shop.id) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => fetchProductTitles(shop, orders));
  catalogReads.set(shop.id, result);
  return result.finally(() => {
    if (catalogReads.get(shop.id) === result) catalogReads.delete(shop.id);
  });
}

async function fetchProductTitles(shop, orders) {
  const catalog = catalogFor(shop);
  if (Date.now() - catalog.created > 15 * 60 * 1000) {
    Object.assign(catalog, { created: Date.now(), cursor: { limit: 100 }, done: false });
  }
  const wanted = new Set(orders.map(order => order.nmId).filter(Boolean));
  for (const id of wanted) if (catalog.titles.has(id)) wanted.delete(id);
  let changed = false;
  try {
    while (wanted.size && !catalog.done) {
      const { cards, cursor } = await queryWB('cards', shop.contentToken || shop.token, {
        settings: { cursor: catalog.cursor, filter: { withPhoto: -1 } },
      });
      if (!Array.isArray(cards) || !Number.isInteger(cursor?.total)) throw new Error('Ответ каталога WB неполный.');
      for (const card of cards) {
        if (typeof card.title === 'string' && card.title.trim()) {
          catalog.titles.set(String(card.nmID), { title: card.title, photoUrl: card.photos?.[0]?.c246x328 || card.photos?.[0]?.square });
          changed = true;
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
  } finally {
    if (changed) {
      try { writeLocalFile(catalogFile(shop), JSON.stringify(Object.fromEntries(catalog.titles))); }
      catch { console.warn('Не удалось записать локальный кеш карточек WB.'); }
    }
  }
}

function refresh(shop) {
  if (pending.has(shop.id)) return pending.get(shop.id);
  const job = (async () => {
    let orders;
    try {
      const result = await queryWB('orders', shop.token);
      orders = result.orders.map(({ id, nmId, article, warehouseId, createdAt, price, currencyCode,
        convertedPrice, convertedCurrencyCode, cargoType, crossBorderType, options, isB2b }) => ({
        id: String(id), nmId: nmId == null ? '' : String(nmId), article, warehouseId, createdAt,
        price, currencyCode, convertedPrice, convertedCurrencyCode, cargoType, crossBorderType, isB2b: options?.isB2B ?? isB2b,
      }));
    } catch (error) {
      const previous = snapshots.get(shop.id);
      snapshots.set(shop.id, { ...previous, error: error.message });
      return;
    }

    const updatedAt = new Date().toISOString();
    saveRuntimeCache(runtimeCacheFile(shop.id, 'orders'), shop.token, Date.now() + 300000, { updatedAt, orders });
    const catalog = catalogFor(shop);
    orders = withCatalog(orders, catalog);
    snapshots.set(shop.id, { orders, updatedAt, error: '', loadingTitles: true });

    let titleError = '';
    try {
      await productTitles(shop, orders);
    } catch (error) {
      titleError = (['401', '403'].includes(error.status)
        ? 'Для названий добавь токен с доступом к категории «Контент». '
        : 'Каталог WB не загрузился. ') + error.message;
    }
    orders = withCatalog(orders, catalog);
    rememberOrders(shop, orders);
    snapshots.set(shop.id, { orders, updatedAt, error: '', titleError });
  })().finally(() => pending.delete(shop.id));
  pending.set(shop.id, job);
  return job;
}

function publicState() {
  return { exchange, shops: shops.map(({ id, name, contentToken }) => ({
    id, name,
    hasContentToken: Boolean(contentToken), busy: pending.has(id), ...snapshots.get(id),
  })) };
}

function orderIds(values) {
  const ids = [...new Set(values.map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('WB вернул некорректный номер заказа.');
  return ids;
}

function supplyMembers(shop, supplyId, fresh = false) {
  const read = () => fetchSupplyMembers(shop, supplyId);
  if (!/^WB-GI-\d+$/.test(supplyId)) return read();
  return cachedSupplyRead(supplyMemberships, shop.id + '/' + supplyId, shop.token, read, 300000,
    runtimeCacheFile(shop.id, 'members-' + supplyId), fresh);
}

async function fetchSupplyMembers(shop, supplyId) {
  const membership = await callWB(supplyOrderIdsCall(supplyId), shop.token);
  if (!Array.isArray(membership?.orderIds)) throw new Error('WB не вернул состав поставки.');
  return orderIds(membership.orderIds);
}

function stickersPDF(orders) {
  if (!mac) throw new Error('Печать стикеров в PDF доступна в версии для macOS.');
  const input = JSON.stringify(orders.map(({ sticker }) => ({ png: sticker.file })));
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/swift', [
      '-module-cache-path', path.join(require('node:os').tmpdir(), 'wb-sticker-swift-cache'),
      path.join(__dirname, 'wb-stickers.swift'),
    ], { encoding: 'buffer', timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout) => error ? reject(new Error('Не удалось сформировать PDF со стикерами. Проверь Swift и повтори.')) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function fetchStickers(shop, ids) {
  if (!ids.length) return Promise.resolve({ stickers: new Map(), warnings: [] });
  const previous = stickerReads.get(shop.id) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => readMissingStickers(shop, ids));
  stickerReads.set(shop.id, result);
  return result.finally(() => {
    if (stickerReads.get(shop.id) === result) stickerReads.delete(shop.id);
  });
}

async function readMissingStickers(shop, ids) {
  let cache = stickerCaches.get(shop.id);
  if (!cache || cache.token !== shop.token) {
    const stored = readRuntimeCache(runtimeCacheFile(shop.id, 'stickers'), shop.token);
    cache = { token: shop.token, entries: new Map(Array.isArray(stored?.value) ?
      stored.value.filter(([, entry]) => entry?.until > Date.now()) : []) };
    stickerCaches.set(shop.id, cache);
  }
  const stickers = new Map();
  const warnings = [];
  const now = Date.now();
  const missing = ids.filter(id => {
    const entry = cache.entries.get(String(id));
    if (!entry || entry.until <= now) return true;
    if (entry.sticker) stickers.set(String(id), entry.sticker);
    return false;
  });
  for (let offset = 0; offset < missing.length; offset += 100) {
    await new Promise(resolve => setTimeout(resolve, 220));
    const batch = missing.slice(offset, offset + 100);
    try {
      const result = await queryWB('stickers', shop.token, { orders: batch });
      if (!Array.isArray(result?.stickers)) throw new Error('WB не вернул список стикеров.');
      const requested = new Set(batch.map(String));
      for (const sticker of result.stickers) {
        const id = String(sticker?.orderId);
        if (!requested.has(id)) continue;
        const number = [sticker.partA, sticker.partB].filter(part => typeof part === 'string' && part.trim()).join(' ');
        const file = typeof sticker.file === 'string' && /^[A-Za-z0-9+/]+=*$/.test(sticker.file) &&
          sticker.file.startsWith('iVBORw0KGgo') ? sticker.file : '';
        const entry = { number, file };
        stickers.set(id, entry);
        if (file) cache.entries.set(id, { sticker: entry, until: now + 5 * 60000 });
      }
      for (const id of requested) {
        if (!stickers.get(id)?.file) cache.entries.set(id, { sticker: stickers.get(id), until: now + 60000 });
      }
    } catch (error) {
      warnings.push(error.message);
      break;
    }
  }
  while (cache.entries.size > 500) cache.entries.delete(cache.entries.keys().next().value);
  if (missing.length && cache.entries.size) {
    saveRuntimeCache(runtimeCacheFile(shop.id, 'stickers'), shop.token, Date.now() + 300000, [...cache.entries]);
  }
  return { stickers, warnings };
}

async function supplyDetails(shop, supplyId) {
  const ids = await supplyMembers(shop, supplyId);
  const { items, warning } = await supplyProducts(shop, ids);
  const { stickers, warnings } = await fetchStickers(shop, ids);
  if (warning) warnings.push(warning);
  return { warnings, orders: ids.map(id => {
    const order = items.get(String(id));
    return { id: String(id), title: order?.title, article: order?.article, sticker: stickers.get(String(id)) };
  }) };
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readInput(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    const limit = ['/api/plan', '/api/supplies/submit'].includes(request.url) ? 4 * 1024 * 1024 : 12000;
    if (body.length > limit) throw new Error('Запрос слишком большой.');
  }
  return JSON.parse(body);
}

const validToken = token => typeof token === 'string' && /^[A-Za-z0-9._~-]{1,4096}$/.test(token);
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'");
  if (request.headers.host !== host + ':' + port) return json(response, 403, { error: 'Открой панель по адресу ' + origin });
  if (request.method === 'GET' && ['/', '/assembly', '/shops', '/vds', '/supplies'].includes(request.url)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(page);
  }
  if (request.method === 'GET' && request.url === '/api/state') return json(response, 200, publicState());
  if (request.method === 'GET' && ['/api/assembly/supplies', '/api/assembly/supplies?fresh=1'].includes(request.url)) {
    const fresh = request.url.endsWith('?fresh=1');
    const results = await Promise.all(shops.map(async shop => {
      const supplies = [];
      const members = new Map();
      seenSupplyOrders.set(shop.id, { token: shop.token, members });
      try {
        for (const supply of await listSupplies(shop, fresh)) {
          if (supply.done !== false) continue;
          await new Promise(resolve => setTimeout(resolve, 220));
          members.set(supply.id, (await supplyMembers(shop, supply.id, fresh)).map(String));
          const ids = members.get(supply.id);
          supplies.push({ id: supply.id, name: supply.name, createdAt: supply.createdAt,
            cargoType: supply.cargoType, orderIds: ids });
        }
        const { items, warning } = await supplyProducts(shop, supplies.flatMap(supply => supply.orderIds));
        for (const supply of supplies) supply.items = supply.orderIds.map(id => items.get(id));
        return { id: shop.id, name: shop.name, supplies, titleWarning: warning };
      } catch (error) {
        return { id: shop.id, name: shop.name, supplies, error: error.message };
      }
    }));
    return json(response, 200, { shops: results });
  }
  if (request.method === 'GET' && request.url === '/api/supplies') {
    const results = await Promise.all(shops.map(async shop => {
      try {
        const supplies = await listSupplies(shop);
        return { id: shop.id, name: shop.name, supplies };
      } catch (error) {
        return { id: shop.id, name: shop.name, supplies: [], error: error.message };
      }
    }));
    return json(response, 200, { shops: results });
  }
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
  if (request.url === '/api/assembly/stickers') {
    const membership = existing && seenSupplyOrders.get(existing.id);
    if (!existing || membership?.token !== existing.token) {
      return json(response, 409, { error: 'Сначала обнови состав открытых поставок.' });
    }
    try {
      const ids = orderIds([...membership.members.values()].flat());
      const { stickers, warnings } = await fetchStickers(existing, ids);
      return json(response, 200, { warnings, orders: ids.map(id => ({ id: String(id), number: stickers.get(String(id))?.number || '' })) });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (['/api/supplies/stickers.pdf', '/api/supplies/imei-template', '/api/supplies/imei'].includes(request.url)) {
    if (!existing || typeof input.supplyId !== 'string' || !/^WB-GI-\d+$/.test(input.supplyId)) {
      return json(response, 400, { error: 'Проверь магазин и номер поставки.' });
    }
    try {
      if (request.url === '/api/supplies/imei-template') {
        const ids = await supplyMembers(existing, input.supplyId);
        const [products, imeis] = await Promise.all([
          supplyProducts(existing, ids, { includePrices: false }),
          readOrderImeis(ids, async (orders, offset) => {
            if (offset) await new Promise(resolve => setTimeout(resolve, 220));
            return callWB({ method: 'POST', url: 'https://marketplace-api.wildberries.ru/api/marketplace/v3/orders/meta',
              body: { orders }, expected: 200 }, existing.token);
          }),
        ]);
        const workbook = imeiTemplate(ids.map(id => {
          const item = products.items.get(String(id));
          return { id, title: item?.title || item?.article, imei: imeis.get(String(id)) };
        }));
        response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="' + input.supplyId + '-IMEI.xlsx"',
          'X-Exported-Imei-Count': String(imeis.size), 'X-Exported-Order-Count': String(ids.length) });
        return response.end(workbook);
      }
      if (request.url.endsWith('.pdf')) {
        const ids = await supplyMembers(existing, input.supplyId);
        const selected = input.orderId == null ? ids : ids.filter(id => String(id) === input.orderId);
        const { stickers, warnings } = await fetchStickers(existing, selected);
        const orders = selected.map(id => ({ id: String(id), sticker: stickers.get(String(id)) })).filter(order => order.sticker?.file);
        if (!orders.length) return json(response, 404, { error: warnings.join(' ') || 'Нет стикеров для скачивания.' });
        const pdf = await stickersPDF(orders);
        response.writeHead(200, { 'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="' + (input.orderId == null ? input.supplyId + '-stickers' : 'WB-' + orders[0].id) + '.pdf"',
          'X-Missing-Stickers': String(selected.length - orders.length) });
        return response.end(pdf);
      }
      const id = typeof input.orderId === 'string' && /^\d+$/.test(input.orderId) ? Number(input.orderId) : NaN;
      if (!Number.isSafeInteger(id) || id < 1 || typeof input.imei !== 'string' || !/^\d{15}$/.test(input.imei)) {
        return json(response, 400, { error: 'IMEI должен состоять из 15 цифр.' });
      }
      if (!(await supplyMembers(existing, input.supplyId, true)).includes(id)) {
        return json(response, 409, { error: 'Заказ больше не находится в этой поставке. Обнови список.' });
      }
      await callWB({ method: 'PUT', url: 'https://marketplace-api.wildberries.ru/api/v3/orders/' + id + '/meta/imei',
        body: { imei: input.imei }, expected: 204 }, existing.token);
      stickerCaches.get(existing.id)?.entries.delete(String(id));
      const stickerCache = stickerCaches.get(existing.id);
      if (stickerCache) saveRuntimeCache(runtimeCacheFile(existing.id, 'stickers'), existing.token, Date.now() + 300000, [...stickerCache.entries]);
      else try { fs.rmSync(runtimeCacheFile(existing.id, 'stickers'), { force: true }); } catch {}
      return json(response, 200, { saved: true });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (request.url === '/api/supplies/details') {
    if (!existing || typeof input.supplyId !== 'string' || !/^WB-GI-\d+$/.test(input.supplyId)) {
      return json(response, 400, { error: 'Проверь магазин и номер поставки.' });
    }
    try {
      const details = await supplyDetails(existing, input.supplyId);
      for (const order of details.orders) {
        if (order.sticker) order.sticker = { number: order.sticker.number, available: Boolean(order.sticker.file) };
      }
      return json(response, 200, details);
    }
    catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (request.url === '/api/vds') return vds
    ? json(response, 200, await testVds())
    : json(response, 503, { error: vdsMissing });
  if (request.url === '/api/plan') {
    if (!Array.isArray(input.keys) || input.keys.some(key => typeof key !== 'string')) {
      return json(response, 400, { error: 'Проверь выбранные заказы.' });
    }
    const plan = planSupplies(publicState().shops, input.keys);
    for (const group of plan.groups) group.choices = supplyChoices(group);
    return json(response, 200, plan);
  }
  if (request.url === '/api/supplies/submit') {
    if (!existing || (input.supplyId !== null && !/^WB-GI-\d+$/.test(input.supplyId)) ||
        !Array.isArray(input.keys) || !input.keys.length ||
        !input.keys.every(key => typeof key === 'string' && key.startsWith(existing.id + '/'))) {
      return json(response, 400, { error: 'Проверь магазин и выбранные заказы.' });
    }
    if (submittingSupply) return json(response, 409, { error: 'Дождись завершения текущей отправки.' });
    submittingSupply = true;
    try {
      const supplyId = await submitSupply(existing, input.keys, input.name, input.supplyId);
      return json(response, 200, { supplyId });
    } catch (error) {
      return json(response, 502, { error: error.message + ' Проверь список поставок и обнови заказы перед повторной отправкой.' });
    } finally {
      submittingSupply = false;
      void refresh(existing);
    }
  }
  if (request.url === '/api/refresh') {
    if (input.id && !existing) return json(response, 404, { error: 'Магазин не найден.' });
    for (const shop of existing ? [existing] : shops) void refresh(shop);
    void refreshRate();
    return json(response, 202, publicState());
  }
  if (!['/api/shop', '/api/remove'].includes(request.url)) return json(response, 404, { error: 'Страница не найдена.' });
  if (submittingSupply) return json(response, 409, { error: 'Дождись завершения текущей отправки.' });
  if (input.id && !existing || request.url === '/api/remove' && !existing) {
    return json(response, 404, { error: 'Магазин не найден.' });
  }
  if (existing && pending.has(existing.id)) return json(response, 409, { error: 'Дождись обновления магазина.' });
  try {
    if (request.url === '/api/remove') {
      saveShops(shops.filter(shop => shop !== existing));
      snapshots.delete(existing.id);
      clearCatalog(existing);
    } else {
      const token = input.token || existing?.token;
      const contentToken = input.clearContentToken ? '' : input.contentToken || existing?.contentToken || '';
      if (!validToken(token) || contentToken && !validToken(contentToken)) {
        return json(response, 400, { error: 'Проверь API-токены магазина.' });
      }
      if (shops.some(shop => shop !== existing && shop.token === token)) {
        return json(response, 409, { error: 'Магазин с этим токеном уже добавлен.' });
      }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) return json(response, 400, { error: 'Введи название магазина (до 80 символов).' });
      const shop = { id: existing?.id || randomUUID(), name, token, contentToken };
      saveShops(existing ? shops.map(item => item === existing ? shop : item) : [...shops, shop]);
      if (!existing || token !== existing.token || contentToken !== existing.contentToken) {
        snapshots.delete(shop.id);
        if (existing) clearCatalog(existing);
        void refresh(shop);
      }
    }
    return json(response, 200, publicState());
  } catch (error) {
    return json(response, 500, { error: error.keychain
      ? error.message : 'Не удалось сохранить настройки магазина в системном хранилище.' });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Порт ' + port + ' уже занят.' : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  if (shops.some(shop => shop.name === 'Временный магазин 1')) {
    const renamed = shops.map(shop => shop.name === 'Временный магазин 1' ? { ...shop, name: 'Fortune' } : shop);
    try { saveShops(renamed); }
    catch (error) {
      shops = renamed;
      console.warn('Fortune отображается в панели, но переименование не сохранено: ' + (error.keychain ? error.message : 'ошибка хранилища.'));
    }
  }
  console.log('Панель WB открыта по адресу ' + origin);
  if (!vds) console.log(vdsMissing);
  for (const shop of shops) {
    const stored = readRuntimeCache(runtimeCacheFile(shop.id, 'orders'), shop.token);
    if (Array.isArray(stored?.value?.orders)) {
      snapshots.set(shop.id, { updatedAt: stored.value.updatedAt, orders: withCatalog(stored.value.orders, catalogFor(shop)), error: '' });
    }
    if (!(stored?.until > Date.now()) || !snapshots.has(shop.id)) void refresh(shop);
  }
  void refreshRate();
});
