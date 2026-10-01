// GENERATED from Xlsx.gs by build.js: the Excel (.xlsx/.xlsm) reader, shared with the server.
/**
 * Xlsx.gs — reads an .xlsx/.xlsm file straight from its zip, no Google conversion needed.
 * Returns the same {name, values[][]} tabs that SpreadsheetApp would, so the lookup parser is shared.
 * Pure string/regex code (no XmlService) so the exact same logic is unit-tested in Node.
 */

/** Apps Script entry: Blob -> tabs. skipFn(name) lets the caller avoid parsing huge irrelevant sheets. */
function xlsxTabsFromBlob_(blob, skipFn) {
  var zipped = blob.setContentType('application/zip');
  var entries = Utilities.unzip(zipped);
  var files = {};
  entries.forEach(function (e) { files[e.getName()] = e; });
  return xlsxTabsFromEntries_(function (name) {
    var e = files[name]; if (!e) return null;
    return e.getDataAsString('UTF-8');
  }, skipFn);
}

/**
 * read(name) returns the text of a zip entry or null.
 * Sheets are parsed in workbook order; rows beyond maxRows are ignored (batch tabs are < 100 rows).
 */
function xlsxTabsFromEntries_(read, skipFn, maxRows) {
  maxRows = maxRows || 400;
  var wb = read('xl/workbook.xml') || '';
  var rels = read('xl/_rels/workbook.xml.rels') || '';
  var relMap = {};
  rels.replace(/<Relationship\b[^>]*>/g, function (tag) {
    var id = xattr_(tag, 'Id'), target = xattr_(tag, 'Target');
    if (id && target) relMap[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    return '';
  });
  var shared = xlsxSharedStrings_(read('xl/sharedStrings.xml') || '');
  var dateStyles = xlsxDateStyles_(read('xl/styles.xml') || '');
  var tabs = [];
  wb.replace(/<sheet\b[^>]*>/g, function (tag) {
    var name = xunesc_(xattr_(tag, 'name') || ''), rid = xattr_(tag, 'r:id') || xattr_(tag, 'id');
    var target = relMap[rid];
    if (!target) return '';
    if (skipFn && skipFn(name)) { tabs.push({ name: name, values: [], skipped: true }); return ''; }
    var xml = read('xl/' + target) || read(target) || '';
    tabs.push({ name: name, values: xlsxSheetValues_(xml, shared, dateStyles, maxRows) });
    return '';
  });
  return tabs;
}

function xlsxSharedStrings_(xml) {
  var out = [];
  xml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, function (_, inner) {
    var text = '';
    inner.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, function (__, t) { text += t; return ''; });
    out.push(xunesc_(text));
    return '';
  });
  return out;
}

/** Which cell style indexes (s="N") render as dates: built-in date formats or custom formats with d/m/y. */
function xlsxDateStyles_(xml) {
  var custom = {};
  xml.replace(/<numFmt\b[^>]*>/g, function (tag) {
    var id = xattr_(tag, 'numFmtId'), code = (xattr_(tag, 'formatCode') || '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/&quot;[^&]*&quot;/g, '');
    if (id) custom[id] = /[dmy]/.test(code) && !/#|0\.0|%/.test(code);
    return '';
  });
  var builtin = { 14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 27: 1, 28: 1, 29: 1, 30: 1, 31: 1, 36: 1, 45: 1, 46: 1, 47: 1, 50: 1, 57: 1, 58: 1 };
  var isDate = {};
  var m = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!m) return isDate;
  var i = 0;
  m[1].replace(/<xf\b[^>]*\/?>/g, function (tag) {
    var id = xattr_(tag, 'numFmtId');
    if (id && (builtin[Number(id)] || custom[id])) isDate[i] = true;
    i++;
    return '';
  });
  return isDate;
}

function xlsxSheetValues_(xml, shared, dateStyles, maxRows) {
  var rows = [];
  var body = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!body) return rows;
  var re = /<row\b([^>]*)>([\s\S]*?)<\/row>/g, rm;
  while ((rm = re.exec(body[1])) !== null) {
    var rIdx = Number(xattr_('<row' + rm[1] + '>', 'r')) - 1;
    if (isNaN(rIdx) || rIdx < 0) continue;
    if (rIdx >= maxRows) break;
    var row = rows[rIdx] || (rows[rIdx] = []);
    var cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
    while ((cm = cre.exec(rm[2])) !== null) {
      var attrs = '<c' + cm[1] + '>', inner = cm[2] || '';
      var ref = xattr_(attrs, 'r'), t = xattr_(attrs, 't'), s = xattr_(attrs, 's');
      var col = xlsxColIndex_(ref);
      if (col < 0) continue;
      var val = '';
      if (t === 's') { var vi = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/); val = vi ? (shared[Number(vi[1])] || '') : ''; }
      else if (t === 'inlineStr') { var txt = ''; inner.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, function (_, x) { txt += x; return ''; }); val = xunesc_(txt); }
      else if (t === 'str' || t === 'e') { var vs = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/); val = vs ? xunesc_(vs[1]) : ''; }
      else if (t === 'b') { var vb = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/); val = vb && vb[1] === '1'; }
      else { var vn = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/); if (vn) { var num = Number(vn[1]); val = isNaN(num) ? vn[1] : (s && dateStyles[Number(s)] ? xlsxSerialToDate_(num) : num); } }
      row[col] = val;
    }
  }
  for (var i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function xlsxSerialToDate_(serial) {
  // Excel 1900 date system; serial 1 = 1900-01-01 (with the Lotus leap-year bug, hence 25569 for the epoch)
  var ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms);
}
function xlsxColIndex_(ref) {
  if (!ref) return -1;
  var m = String(ref).match(/^([A-Z]+)/); if (!m) return -1;
  var n = 0; for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
  return n - 1;
}
function xattr_(tag, name) {
  var m = tag.match(new RegExp('\\s' + name.replace(':', '\\:') + '="([^"]*)"'));
  return m ? m[1] : null;
}
function xunesc_(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); }).replace(/&amp;/g, '&');
}
