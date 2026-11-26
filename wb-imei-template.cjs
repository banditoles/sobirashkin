const { zipFiles } = require('./wb-zip.cjs');

async function readOrderImeis(ids, readBatch) {
  const imeis = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const requested = new Set(batch.map(String));
    const result = await readBatch(batch, offset);
    if (!Array.isArray(result?.orders)) throw new Error('WB не вернул данные маркировки заказов.');
    for (const order of result.orders) {
      const id = String(order?.id);
      if (!requested.has(id)) continue;
      const details = Array.isArray(order.metaDetails) ? order.metaDetails : [];
      const candidates = details.filter(item => item?.key === 'imei').map(item => item.value);
      candidates.push(order.meta?.imei?.value, order.meta?.imei);
      const imei = candidates.map(value => typeof value === 'string' || Number.isSafeInteger(value) ? String(value).trim() : '')
        .find(value => /^\d{15}$/.test(value));
      if (imei) imeis.set(id, imei);
    }
  }
  return imeis;
}

function imeiTemplate(orders) {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relations = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const escape = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = (cell, value, style = '') => '<c r="' + cell + '"' + style + ' t="inlineStr"><is><t>' + escape(value) + '</t></is></c>';
  const rows = ['<row r="1">' + text('A1', 'Заказ') + text('B1', 'Название товара') + text('C1', 'IMEI') + '</row>'];
  for (const [index, { id, title, imei }] of orders.entries()) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Некорректный номер заказа для шаблона.');
    const row = index + 2;
    rows.push('<row r="' + row + '">' + text('A' + row, id) + text('B' + row, title) +
      text('C' + row, imei, ' s="1"') + '</row>');
  }
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="' + relations + '"><Relationship Id="rId1" Type="' + office + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="' + main + '" xmlns:r="' + office + '"><sheets><sheet name="IMEI" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="' + relations + '"><Relationship Id="rId1" Type="' + office + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + office + '/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet xmlns="' + main + '"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="' + main + '"><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="65" customWidth="1"/><col min="3" max="3" width="23" customWidth="1"/></cols><sheetData>' + rows.join('') + '</sheetData></worksheet>',
  };
  return zipFiles(Object.entries(files).map(([name, xml]) => ({
    name, data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' + xml),
  })));
}

module.exports = { imeiTemplate, readOrderImeis };
