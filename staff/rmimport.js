/*
 * rmimport.js — reads the Receipt Maker (Receipt_Maker.xlsm) in the browser, so the owner can bring its Receipt_Log into the app
 * (the numbers carry on from it), and builds the rows to paste back into Receipt_Log for the receipts the app made.
 * Needs xlsx.js (the same Excel reader the server uses) and DecompressionStream('deflate-raw') (Chrome, Edge, Safari 16.4+).
 */
(function (root) {
  'use strict';

  /** .xlsx/.xlsm (a zip) -> { 'xl/workbook.xml': text, ... } for the xml parts. */
  async function unzipXml(buf) {
    var b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = {};
    var eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That isn’t an Excel file.');
    var n = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true);
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The Excel file looks damaged.');
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      var local = dv.getUint32(p + 42, true), name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (!/^xl\/.*\.(xml|rels)$/.test(name) || /^xl\/(media|vbaProject|printerSettings|drawings)/.test(name)) continue;
      var lnl = dv.getUint16(local + 26, true), lel = dv.getUint16(local + 28, true), data = b.subarray(local + 30 + lnl + lel, local + 30 + lnl + lel + csize);
      var raw = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
      if (raw) out[name] = new TextDecoder().decode(raw);
    }
    return out;
  }
  function inflateRaw(u8) {
    return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer().then(function (x) { return new Uint8Array(x); });
  }

  function ymd(v) {
    if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v) ? '' : v.toISOString().slice(0, 10);   // Excel dates arrive as UTC midnight
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[0] : '';
  }
  function num(v) { var x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : 0; }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }

  /** Receipt_Log rows -> receipts (one per number + student), the shape the app imports. */
  function receiptsFromLog(values) {
    var head = (values[0] || []).map(str), col = {};
    head.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });
    var need = ['Receipt_No', 'Student_ID', 'Receipt_Date', 'Payment_Date', 'Amount'];
    need.forEach(function (h) { if (col[h] === undefined) throw new Error('Receipt_Log has no ' + h + ' column.'); });
    var g = function (r, h) { return col[h] === undefined ? '' : r[col[h]]; };
    var recs = {}, order = [], old = {};
    for (var i = 1; i < values.length; i++) {
      var r = values[i] || [], no = str(g(r, 'Receipt_No'));
      if (!no) { if (str(r[1])) (old[str(r[1]) + '|' + str(r[2]).toUpperCase()] = old[str(r[1]) + '|' + str(r[2]).toUpperCase()] || []).push(r); continue; }
      if (str(g(r, 'Run_Mode')) && str(g(r, 'Run_Mode')).toUpperCase() !== 'LIVE') continue;
      var sid = str(g(r, 'Student_ID')).toUpperCase(), key = no + '|' + sid, x = recs[key];
      if (!x) {
        x = recs[key] = { no: no, studentId: /^PIC/.test(sid) ? sid : '', name: str(g(r, 'Student_Name')), program: str(g(r, 'Program')), batch: str(g(r, 'Batch_Name')) || str(g(r, 'Batch_ID')),
          batchStart: ymd(g(r, 'Batch_Start_Date')), date: ymd(g(r, 'Receipt_Date')), lines: [], issuedBy: str(g(r, 'Receipt_Issued_By')),
          template: /old/i.test(str(g(r, 'Template_Used'))) ? 'old' : 'new', title: 'Tuition Receipt', status: 'ok' };
        order.push(key);
      }
      x.lines.push({ slot: str(g(r, 'Payment_Slot')), desc: str(g(r, 'Description')), method: str(g(r, 'Method')), date: ymd(g(r, 'Payment_Date')), amount: num(g(r, 'Amount')) });
      if (/^void$/i.test(str(g(r, 'Receipt_Status')))) x.status = 'void';
    }
    // the first Receipt Maker wrote a shorter row (Receipt Number, Student ID, ...): only used when the newer columns don't have that receipt
    Object.keys(old).forEach(function (k) {
      if (recs[k]) return;
      var rows = old[k], r0 = rows[0], d = ymd(r0[5]);
      recs[k] = { no: str(r0[1]), studentId: str(r0[2]).toUpperCase(), name: str(r0[3]), program: 'NACC Personal Support Worker 2022', batch: str(r0[0]), batchStart: '', date: d,
        lines: rows.map(function (r) { return { slot: (str(r[10]).split('|')[1] || '').replace('TUITION-', 'TUITION_'), desc: str(r[6]), method: str(r[7]), date: ymd(r[5]), amount: num(r[8]) }; }),
        issuedBy: d >= '2026-06-01' ? 'Harmohit (Accounts & Finance Administrator)' : 'Navneet (Admissions Officer)', template: d >= '2026-06-01' ? 'new' : 'old', title: 'Tuition Receipt', status: 'ok' };
      order.push(k);
    });
    return order.map(function (k) { return recs[k]; }).filter(function (x) { return x.date && x.lines.length && x.lines.every(function (l) { return l.date && l.amount > 0; }); });
  }

  /** Receipt_Maker.xlsm (ArrayBuffer) -> { receipts, from } */
  async function fromWorkbook(buf) {
    var files = await unzipXml(buf);
    var tabs = root.xlsxTabsFromEntries_(function (name) { return files[name] || null; }, function (name) { return name !== 'Receipt_Log'; }, 20000);
    var log = tabs.filter(function (t) { return t.name === 'Receipt_Log'; })[0];
    if (!log || !log.values.length) throw new Error('This file has no Receipt_Log sheet. Choose Receipt_Maker.xlsm.');
    return { receipts: receiptsFromLog(log.values), rows: log.values.length - 1 };
  }

  /* ---------- the app's receipts, as rows for the bottom of Receipt_Log (same 44 columns, one row per line) ---------- */
  var LOG_COLUMNS = ['Batch', 'Receipt Number', 'Student ID', 'Student Name', 'Receipt Generated Date', 'Payment Date', 'Payment Description', 'Payment Method', 'Payment Amount',
    'Receipt Total', 'Transaction Identifier', 'PDF File Path', 'Transaction_ID', 'Receipt_ID', 'Receipt_No', 'Receipt_Date', 'Student_ID', 'Student_Name', 'Program', 'Batch_ID', 'Batch_Name',
    'Batch_Start_Date', 'Source_Sheet', 'Source_Row', 'Payment_Slot', 'Payment_Type', 'Payment_Date', 'Payment_Year', 'Payment_Month', 'Description', 'Amount', 'Method', 'Quoted_Fee',
    'Books_Status', 'Template_Used', 'Receipt_Issued_By', 'Receipt_Source', 'Receipt_Status', 'PDF_Path', 'Copies_Generated', 'Notes', 'Actual_PDF_Created', 'Created_By', 'Run_Mode'];
  var MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  function logRows(receipts) {
    var rows = [];
    receipts.forEach(function (r) {
      (r.lines || []).forEach(function (l, i) {
        var o = {
          Transaction_ID: 'APP|' + (r.cashId || r.no) + '|' + (i + 1), Receipt_ID: (r.studentId || 'EXTERNAL') + '|' + r.no, Receipt_No: r.no, Receipt_Date: r.date,
          Student_ID: r.studentId || '', Student_Name: r.name, Program: r.program || '', Batch_ID: r.batch || '', Batch_Name: r.batch || '', Batch_Start_Date: r.batchStart || '',
          Source_Sheet: 'PRIME Staff app', Source_Row: '', Payment_Slot: l.slot || '', Payment_Type: /^TUITION/.test(l.slot || '') ? 'Tuition' : 'Extra Fee', Payment_Date: l.date,
          Payment_Year: String(l.date).slice(0, 4), Payment_Month: MONTHS[Number(String(l.date).slice(5, 7)) - 1] || '', Description: l.desc, Amount: l.amount, Method: l.method,
          Template_Used: r.template === 'old' ? 'Receipt_Template_Old_Address' : 'Receipt_Template_New_Address', Receipt_Issued_By: r.issuedBy, Receipt_Source: 'PRIME Staff app (cash at the desk)',
          Receipt_Status: r.status === 'void' ? 'Void' : 'Generated', Copies_Generated: 0, Notes: (r.cashId ? 'Cash ' + r.cashId : '') + (r.status === 'void' && r.voidReason ? ' · void: ' + r.voidReason : ''),
          Actual_PDF_Created: String(r.createdAt || '').replace('T', ' ').slice(0, 19), Created_By: r.createdBy || '', Run_Mode: 'LIVE'
        };
        rows.push(LOG_COLUMNS.map(function (h) { return o[h] === undefined ? '' : o[h]; }));
      });
    });
    return rows;
  }
  function cell(v, sep) { v = String(v === null || v === undefined ? '' : v).replace(/[\r\n\t]+/g, ' '); return sep === ',' && /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function tsv(rows) { return rows.map(function (r) { return r.map(function (v) { return cell(v, '\t'); }).join('\t'); }).join('\n'); }
  function csv(rows) { return [LOG_COLUMNS].concat(rows).map(function (r) { return r.map(function (v) { return cell(v, ','); }).join(','); }).join('\r\n'); }

  var api = { fromWorkbook: fromWorkbook, receiptsFromLog: receiptsFromLog, unzipXml: unzipXml, logRows: logRows, tsv: tsv, csv: csv, LOG_COLUMNS: LOG_COLUMNS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PrimeRM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
