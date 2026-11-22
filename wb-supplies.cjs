const moscowDay = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium' });
const marketplace = 'https://marketplace-api.wildberries.ru';

function supplyName(day, order) {
  const base = 'Поставка от ' + day;
  if (order.cargoType === 1 && order.crossBorderType === 0 && order.isB2b === false) return base;
  return base + ' / ' + [order.cargoType ?? '?', order.crossBorderType ?? '?', order.isB2b == null ? '?' : Number(order.isB2b)].join('-');
}

function planSupplies(shops, keys, now = new Date()) {
  const selected = new Set(keys);
  const groups = new Map();
  const day = moscowDay.format(now).replace(/\s*г\.$/, '');
  for (const shop of shops) {
    for (const order of shop.orders || []) {
      const key = shop.id + '/' + order.id;
      if (!selected.delete(key)) continue;
      const parts = [order.warehouseId, order.cargoType, order.crossBorderType, order.isB2b];
      const groupKey = JSON.stringify([shop.id, ...parts]);
      if (!groups.has(groupKey)) groups.set(groupKey, {
        shopId: shop.id, shop: shop.name, warehouseId: order.warehouseId, cargoType: order.cargoType,
        crossBorderType: order.crossBorderType, isB2b: order.isB2b,
        name: supplyName(day, order), orderIds: [], incomplete: parts.some(value => value == null), stale: Boolean(shop.error),
      });
      groups.get(groupKey).orderIds.push(order.id);
    }
  }
  for (const group of groups.values()) {
    const peers = [...groups.values()].filter(candidate => candidate.shopId === group.shopId && candidate.name === group.name);
    if (peers.length > 1) group.displayName = group.name + ' · склад ' + (group.warehouseId ?? '—');
  }
  return { groups: [...groups.values()], missing: [...selected] };
}

function listSuppliesCall(next = 0) {
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid WB supply cursor');
  return { method: 'GET', url: marketplace + '/api/v3/supplies?limit=1000&next=' + next, expected: 200 };
}

function writeCalls(group, supplies) {
  if (group.stale || group.incomplete || !group.orderIds.length) throw new Error('Supply group must be current and complete');
  // The list response lacks the originating warehouse. Supply candidates must be
  // enriched from confirmed origin data before they reach this matcher.
  const matching = supplies.filter(supply => (supply.name === group.name || supply.name === group.displayName) &&
    supply.done === false && supply.originWarehouseId === group.warehouseId && supply.cargoType === group.cargoType &&
    supply.crossBorderType === group.crossBorderType && supply.isB2b === group.isB2b);
  if (matching.length > 1) throw new Error('Multiple eligible supplies require reconciliation');
  const supply = matching[0];
  if (!supply && supplies.some(item => (item.name === group.name || item.name === group.displayName) &&
    item.done === false && item.originWarehouseId == null)) throw new Error('Verify warehouse of the open supply');
  const orders = [...new Set(group.orderIds.map(Number))];
  if (orders.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid safe integer WB order ID');
  const create = supply ? null : {
    method: 'POST', url: marketplace + '/api/v3/supplies', expected: 201, body: { name: group.displayName || group.name },
  };
  return {
    supplyId: supply?.id || null,
    create,
    append(supplyId) {
      if (!/^WB-GI-\d+$/.test(supplyId)) throw new Error('Invalid WB supply ID');
      const calls = [];
      for (let offset = 0; offset < orders.length; offset += 100) calls.push({
        method: 'PATCH', url: marketplace + '/api/marketplace/v3/supplies/' + supplyId + '/orders',
        expected: 204, body: { orders: orders.slice(offset, offset + 100) },
      });
      return calls;
    },
  };
}

module.exports = { planSupplies, listSuppliesCall, writeCalls };
