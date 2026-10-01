/*
 * receipt.js — makes the student receipt PDF on the phone, in the Receipt Maker's layout (Receipt_Template_New_Address /
 * _Old_Address): logo + college header, Student Information, Receipt Date / No., 4 payment lines, amount in words, total,
 * issued by, E&OE. One receipt per page (US Letter). No libraries: a small PDF writer with the built-in Helvetica fonts
 * and the logo as a JPEG. Works in the browser and in Node (tests).
 *
 *   PrimeReceipt.pdf(receipts, logoJpegBytes) -> Uint8Array
 *   receipt = { no, studentId, name, program, date: 'yyyy-mm-dd', lines: [{desc, method, date, amount}], total, words,
 *               issuedBy, template: 'new'|'old', title, status, test }
 */
(function (root) {
  'use strict';
  var COLLEGE = 'Prime International College of Health Care and Technology';
  var ADDRESS = { 'new': '144 - 2960 Drew Rd, Mississauga, ON, L4T 0A5', old: '638A, Unit 212C Sheppard Ave W, North York, ON , M3H 2S1,Canada' };
  var CONTACT = '647-499-1009 | accounts@primeinternational.ca';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Helvetica / Helvetica-Bold advance widths (1/1000 em) for WinAnsi 32..126
  var W = {
    F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
      1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
      333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
    F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
      975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
      333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]
  };

  /** Text to WinAnsi bytes (Latin-1 range kept; curly quotes/dashes mapped; anything else becomes '?'). */
  function ansi(s) {
    s = String(s == null ? '' : s).replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[\r\n\t]+/g, ' ');
    var out = '';
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out += (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? s.charAt(i) : '?'; }
    return out;
  }
  function width(s, font, size) {
    var t = 0, w = W[font];
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); t += c >= 32 && c <= 126 ? w[c - 32] : 556; }
    return t * size / 1000;
  }
  function fit(s, font, size, max) {   // shrink to fit, then cut with ...
    s = ansi(s);
    while (size > 6 && width(s, font, size) > max) size -= 0.5;
    if (width(s, font, size) <= max) return { s: s, size: size };
    while (s.length > 1 && width(s + '...', font, size) > max) s = s.slice(0, -1);
    return { s: s + '...', size: size };
  }
  function pdfStr(s) { return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'; }
  function n(x) { return (Math.round(x * 100) / 100).toString(); }
  function money(x) {
    var v = Math.round(Number(x) * 100) / 100, p = v.toFixed(2).split('.');
    return '$' + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + p[1];
  }
  function longDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : String(ymd || '');
  }

  /** One page's drawing commands. Coordinates are from the top-left in points; flipped for PDF. */
  function page(r) {
    var H = 792, ops = [];
    var Y = function (y) { return H - y; };
    var line = function (x1, y1, x2, y2, w, dash) { ops.push((dash ? '[2 2] 0 d ' : '[] 0 d ') + n(w || 0.75) + ' w ' + n(x1) + ' ' + n(Y(y1)) + ' m ' + n(x2) + ' ' + n(Y(y2)) + ' l S'); };
    var rect = function (x, y, w, h, lw) { ops.push('[] 0 d ' + n(lw || 0.75) + ' w ' + n(x) + ' ' + n(Y(y + h)) + ' ' + n(w) + ' ' + n(h) + ' re S'); };
    var text = function (s, x, y, font, size, align, maxW, gray) {
      var f = fit(s, font, size, maxW || 560), tw = width(f.s, font, f.size);
      var tx = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
      ops.push('BT ' + (gray ? n(gray) + ' g ' : '0 g ') + '/' + font + ' ' + n(f.size) + ' Tf ' + n(tx) + ' ' + n(Y(y)) + ' Td ' + pdfStr(f.s) + ' Tj ET');
      return tw;
    };
    var underline = function (s, x, y, font, size) { var tw = text(s, x, y, font, size); line(x, y + 1.6, x + tw, y + 1.6, 0.7); };
    var L = 20, R = 592, MID = 320;

    // header
    ops.push('q 184 0 0 66 26 ' + n(Y(22 + 66)) + ' cm /Im1 Do Q');
    text(COLLEGE, R - 3, 27, 'F2', 9.4, 'right', 380);
    text(r.template === 'old' ? ADDRESS.old : ADDRESS['new'], R - 3, 44, 'F1', 9, 'right', 380);
    text(CONTACT, R - 3, 60, 'F1', 9, 'right', 380);
    text(r.title || 'Tuition Receipt', 306, 82, 'F2', 11, 'center');
    rect(L, 12, R - L, 362, 1.4);
    line(L, 97, R, 97, 1);

    // student information (left) and receipt date / number (right)
    var sid = r.studentId || 'N/A', prog = r.studentId ? (r.program || '') : (r.program || 'N/A');
    rect(L, 97, MID - 2 - L, 92, 1);
    line(L, 120, MID - 2, 120); line(L, 143, MID - 2, 143); line(L, 166, MID - 2, 166); line(107, 120, 107, 189);
    text('Student Information', (L + MID - 2) / 2, 113, 'F2', 11, 'center');
    [['Student Name:', r.name], ['Student ID:', sid], ['Program Name:', prog]].forEach(function (p, i) {
      var y = 136 + i * 23;
      text(p[0], L + 3, y, 'F2', 8.5, 'left', 84);
      text(p[1] || '', (107 + MID - 2) / 2, y, 'F1', 9, 'center', MID - 2 - 107 - 6);
    });
    rect(MID + 2, 97, R - MID - 2, 46, 1); line(MID + 2, 120, R, 120); line(500, 97, 500, 143);
    text('Receipt Date', (MID + 2 + 500) / 2, 113, 'F2', 9.5, 'center');
    text('Receipt No.', (MID + 2 + 500) / 2, 136, 'F2', 9.5, 'center');
    text(longDate(r.date), (500 + R) / 2, 113, 'F2', 8.5, 'center', 88);
    text(r.no, (500 + R) / 2, 136, 'F2', 8.5, 'center', 88);
    line(MID + 2, 143, MID + 2, 189); line(MID + 2, 189, R, 189);

    // payment lines
    var cols = [L, MID, 414, 502, R];
    rect(L, 196, R - L, 100, 1);
    line(L, 214, R, 214, 1);
    for (var c = 1; c < 4; c++) line(cols[c], 196, cols[c], 296);
    text('Description', (cols[0] + cols[1]) / 2, 209, 'F2', 9.5, 'center');
    text('Payment Method', (cols[1] + cols[2]) / 2, 209, 'F2', 9.5, 'center', 92);
    text('Date', (cols[2] + cols[3]) / 2, 209, 'F2', 9.5, 'center');
    text('Amount', (cols[3] + cols[4]) / 2, 209, 'F2', 9.5, 'center');
    var lines = (r.lines || []).slice(0, 4);
    for (var i = 0; i < 4; i++) {
      var top = 214 + i * 20.5, y = top + 14;
      if (i < 3) line(L, top + 20.5, R, top + 20.5, 0.6, true);
      var ln = lines[i]; if (!ln) continue;
      text(ln.desc || '', (cols[0] + cols[1]) / 2, y, 'F1', 10, 'center', cols[1] - cols[0] - 8);
      text(ln.method || '', (cols[1] + cols[2]) / 2, y, 'F1', 8.5, 'center', cols[2] - cols[1] - 6);
      text(longDate(ln.date), (cols[2] + cols[3]) / 2, y, 'F1', 8.5, 'center', cols[3] - cols[2] - 6);
      text(money(ln.amount), cols[4] - 4, y, 'F2', 8.5, 'right', cols[4] - cols[3] - 6);
    }

    // words + total
    rect(L, 300, MID - 2 - L, 20, 1);
    text(r.words || '', (L + MID - 2) / 2, 314, 'F2', 8.5, 'center', MID - 2 - L - 8);
    rect(MID + 2, 300, R - MID - 2, 20, 1); line(500, 300, 500, 320);
    text('Total:', 480, 315, 'F2', 11, 'right');
    text(money(r.total), R - 4, 315, 'F2', 11, 'right', R - 500 - 8);

    // notes + issued by
    line(L, 320, MID - 2, 320);
    underline('Notes:', L + 3, 331, 'F2', 10);
    line(MID + 2, 326, R, 326, 1); line(MID + 2, 326, MID + 2, 374);
    underline('Receipt Issued By (Staff Name & Title)', MID + 6, 343, 'F2', 10);
    text(r.issuedBy || '', MID + 6, 364, 'F1', 10, 'left', R - MID - 12);
    text('E&OE', R - 2, 384, 'F1', 8, 'right');

    // void / practice stamp, drawn first so it sits behind the text
    var st = r.status === 'void' ? 'VOID' : r.test ? 'TEST' : '';
    if (st) ops.unshift('q 0.86 g BT /F2 96 Tf 0.94 0.34 -0.34 0.94 ' + (st === 'VOID' ? 190 : 200) + ' ' + n(Y(330)) + ' Tm ' + pdfStr(st) + ' Tj ET Q');
    return ops.join('\n');
  }

  function jpegSize(b) {
    for (var i = 2; i < b.length - 9;) {
      if (b[i] !== 0xFF) { i++; continue; }
      var m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
    throw new Error('Logo is not a JPEG.');
  }
  function bytes(s) { var u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }

  function pdf(receipts, logo) {
    if (!receipts || !receipts.length) throw new Error('No receipts.');
    logo = logo instanceof Uint8Array ? logo : new Uint8Array(logo);
    var sz = jpegSize(logo);
    var parts = [], offsets = [], len = 0;
    function push(u) { parts.push(u); len += u.length; }
    function obj(id, body) { offsets[id] = len; push(bytes(id + ' 0 obj\n')); if (typeof body === 'string') push(bytes(body)); else body.forEach(push); push(bytes('\nendobj\n')); }
    push(bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    var pageIds = [], first = 6;
    receipts.forEach(function (r, i) { pageIds.push(first + i * 2); });
    var info = receipts.length === 1 ? 'Receipt ' + receipts[0].no + ' - ' + (receipts[0].name || '') : receipts.length + ' receipts';
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + pageIds.map(function (p) { return p + ' 0 R'; }).join(' ') + '] /Count ' + pageIds.length + ' >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, [bytes('<< /Type /XObject /Subtype /Image /Width ' + sz.w + ' /Height ' + sz.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + logo.length + ' >>\nstream\n'), logo, bytes('\nendstream')]);
    receipts.forEach(function (r, i) {
      var id = pageIds[i], content = bytes(page(r));
      obj(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents ' + (id + 1) + ' 0 R >>');
      obj(id + 1, [bytes('<< /Length ' + content.length + ' >>\nstream\n'), content, bytes('\nendstream')]);
    });
    var infoId = first + receipts.length * 2;
    obj(infoId, '<< /Title ' + pdfStr(ansi(info)) + ' /Producer (PRIME Staff) >>');
    var xref = len, total = infoId + 1, x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var k = 1; k < total; k++) x += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
    push(bytes(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
    var out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  var api = { pdf: pdf, money: money, longDate: longDate, fileName: function (rs) {
    var r = rs[0], safe = function (s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''); };
    return rs.length === 1 ? (r.studentId ? safe(r.studentId) + '_' : '') + safe(r.name) + '_' + safe(r.no) + '.pdf' : 'Receipts_' + rs.length + '_' + safe(r.date) + '.pdf';
  } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PrimeReceipt = api;
})(this);
