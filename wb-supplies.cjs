const moscowDay = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium' });
const supplyDay = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
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
    for (const rawOrder of shop.orders || []) {
      const order = { ...rawOrder, isB2b: rawOrder.options?.isB2B ?? rawOrder.isB2b };
      const key = shop.id + '/' + order.id;
      if (!selected.delete(key)) continue;
      const parts = [order.warehouseId, order.cargoType, order.crossBorderType, order.isB2b];
      const groupKey = JSON.stringify([shop.id, ...parts]);
      if (!groups.has(groupKey)) groups.set(groupKey, {
        shopId: shop.id, shop: shop.name, warehouseId: order.warehouseId, cargoType: order.cargoType,
        crossBorderType: order.crossBorderType, isB2b: order.isB2b,
        name: 'Поставка от ' + supplyDay.format(now), orderIds: [], incomplete: parts.some(value => value == null), stale: Boolean(shop.error),
      });
      groups.get(groupKey).orderIds.push(order.id);
    }
  }
  for (const group of groups.values()) {
    group.displayName = supplyName(day, group) + ' · склад ' + (group.warehouseId ?? '—') + ' · Собирашкин';
  }
  return { groups: [...groups.values()], missing: [...selected] };
}

function listSuppliesCall(next = 0) {
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid WB supply cursor');
  return { method: 'GET', url: marketplace + '/api/v3/supplies?limit=1000&next=' + next, expected: 200 };
}

function supplyOrderIdsCall(supplyId) {
  if (!/^WB-GI-\d+$/.test(supplyId)) throw new Error('Некорректный ID поставки WB.');
  return { method: 'GET', url: marketplace + '/api/marketplace/v3/supplies/' + supplyId + '/order-ids', expected: 200 };
}

function writeCalls(group, supplies) {
  if (group.stale || group.incomplete || !group.orderIds.length) throw new Error('Supply group must be current and complete');
  const matching = supplies.filter(supply => supply.done === false);
  if (matching.length > 1) throw new Error('В WB несколько открытых поставок с одним именем. Проверь их вручную.');
  const supply = matching[0];
  if (supply && !supply.empty && (supply.cargoType !== group.cargoType ||
      supply.crossBorderType !== group.crossBorderType || supply.isB2b !== group.isB2b)) {
    throw new Error('Открытая поставка несовместима с выбранными заказами.');
  }
  const orders = [...new Set(group.orderIds.map(Number))];
  if (orders.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid safe integer WB order ID');
  const create = supply ? null : {
    method: 'POST', url: marketplace + '/api/v3/supplies', expected: 201, body: { name: group.name },
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

module.exports = { planSupplies, listSuppliesCall, supplyOrderIdsCall, writeCalls };
