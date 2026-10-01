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

  /** Drawing helpers for one page. Coordinates are from the top-left in points; flipped for PDF. */
  function drawer() {
    var H = 792, ops = [];
    var Y = function (y) { return H - y; };
    var D = { ops: ops, Y: Y };
    D.line = function (x1, y1, x2, y2, w, dash) { ops.push((dash ? '[2 2] 0 d ' : '[] 0 d ') + n(w || 0.75) + ' w ' + n(x1) + ' ' + n(Y(y1)) + ' m ' + n(x2) + ' ' + n(Y(y2)) + ' l S'); };
    D.rect = function (x, y, w, h, lw) { ops.push('[] 0 d ' + n(lw || 0.75) + ' w ' + n(x) + ' ' + n(Y(y + h)) + ' ' + n(w) + ' ' + n(h) + ' re S'); };
    D.text = function (s, x, y, font, size, align, maxW, gray) {
      var f = fit(s, font, size, maxW || 560), tw = width(f.s, font, f.size);
      var tx = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
      ops.push('BT ' + (gray ? n(gray) + ' g ' : '0 g ') + '/' + font + ' ' + n(f.size) + ' Tf ' + n(tx) + ' ' + n(Y(y)) + ' Td ' + pdfStr(f.s) + ' Tj ET');
      return tw;
    };
    D.underline = function (s, x, y, font, size) { var tw = D.text(s, x, y, font, size); D.line(x, y + 1.6, x + tw, y + 1.6, 0.7); };
    D.image = function (name, x, y, w, h) { ops.push('q ' + n(w) + ' 0 0 ' + n(h) + ' ' + n(x) + ' ' + n(Y(y + h)) + ' cm /' + name + ' Do Q'); };
    D.header = function (title, template) {   // logo, college, address, contact, title (same on receipts and cash records)
      D.image('Im1', 26, 22, 184, 66);
      D.text(COLLEGE, 589, 27, 'F2', 9.4, 'right', 380);
      D.text(template === 'old' ? ADDRESS.old : ADDRESS['new'], 589, 44, 'F1', 9, 'right', 380);
      D.text(CONTACT, 589, 60, 'F1', 9, 'right', 380);
      D.text(title, 306, 82, 'F2', 11, 'center');
    };
    D.stamp = function (st) { if (st) ops.unshift('q 0.86 g BT /F2 96 Tf 0.94 0.34 -0.34 0.94 ' + (st === 'VOID' ? 190 : 200) + ' ' + n(Y(330)) + ' Tm ' + pdfStr(st) + ' Tj ET Q'); };
    return D;
  }

  /**
   * One receipt page. extra (cash at the desk): { recordNo, sigs: {student, staff} (true when the image is there),
   * studentName, staffName } adds the cash record number under Receipt No. and both signatures under the receipt.
   */
  function page(r, extra) {
    var D = drawer(), ops = D.ops, Y = D.Y, line = D.line, rect = D.rect, text = D.text, underline = D.underline;
    var L = 20, R = 592, MID = 320;

    // header
    D.header(r.title || 'Tuition Receipt', r.template);
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
    if (extra && extra.recordNo) {
      rect(MID + 2, 143, R - MID - 2, 23, 1); line(500, 143, 500, 166);
      text('Cash Record No.', (MID + 2 + 500) / 2, 159, 'F2', 9.5, 'center');
      text(extra.recordNo, (500 + R) / 2, 159, 'F2', 8.5, 'center', 88);
    }

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
    if (extra) {   // both signatures, under the receipt
      var S = 396;
      [['Student Signature', 'Im2', extra.studentName || r.name, extra.sigs && extra.sigs.student], ['Received By (Staff Signature)', 'Im3', extra.staffName || '', extra.sigs && extra.sigs.staff]].forEach(function (b, k) {
        var x0 = k ? MID + 2 : L, x1 = k ? R : MID - 2, bw = x1 - x0;
        rect(x0, S, bw, 112, 1);
        underline(b[0], x0 + 4, S + 13, 'F2', 10);
        if (b[3]) { var ih = 66, iw = Math.min(bw - 20, ih * 3); D.image(b[1], x0 + (bw - iw) / 2, S + 19, iw, ih); }
        line(x0 + 12, S + 90, x1 - 12, S + 90, 0.6);
        text(b[2], x0 + bw / 2, S + 104, 'F1', 9.5, 'center', bw - 20);
      });
    }

    // void / practice stamp, drawn first so it sits behind the text
    D.stamp(r.status === 'void' ? 'VOID' : r.test ? 'TEST' : '');
    return ops.join('\n');
  }

  function torontoParts(iso) {
    var d = new Date(iso); if (isNaN(d)) return { date: '', time: '' };
    try {
      return { date: d.toLocaleDateString('en-US', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', year: 'numeric' }),
        time: d.toLocaleTimeString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit' }) };
    } catch (e) { return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) + ' UTC' }; }
  }
  /** "FNU NAVNEET KAUR" -> "Navneet Kaur" (same as the receipts) */
  function titleCase(s) {
    return String(s || '').replace(/[.,]/g, ' ').split(/\s+/).filter(function (w) { return w && !/^(fnu|lnu|-+)$/i.test(w); })
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(' ');
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

  function asBytes(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  /** images: { Im1: {kind:'jpeg', bytes} | {kind:'flate', w, h, bytes (zlib RGB)} , ... } */
  function build(pageOps, images, title) {
    var parts = [], offsets = [], len = 0;
    function push(u) { parts.push(u); len += u.length; }
    function obj(id, body) { offsets[id] = len; push(bytes(id + ' 0 obj\n')); if (typeof body === 'string') push(bytes(body)); else body.forEach(push); push(bytes('\nendobj\n')); }
    push(bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    var names = Object.keys(images), imgIds = {}, next = 5;
    names.forEach(function (nm) { imgIds[nm] = next++; });
    var pageIds = pageOps.map(function (p, i) { return next + i * 2; });
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + pageIds.map(function (p) { return p + ' 0 R'; }).join(' ') + '] /Count ' + pageIds.length + ' >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    names.forEach(function (nm) {
      var im = images[nm], b = asBytes(im.bytes), w = im.w, h = im.h, filter = '/FlateDecode';
      if (im.kind === 'jpeg') { var sz = jpegSize(b); w = sz.w; h = sz.h; filter = '/DCTDecode'; }
      obj(imgIds[nm], [bytes('<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ' + filter + ' /Length ' + b.length + ' >>\nstream\n'), b, bytes('\nendstream')]);
    });
    var xo = names.map(function (nm) { return '/' + nm + ' ' + imgIds[nm] + ' 0 R'; }).join(' ');
    pageOps.forEach(function (ops, i) {
      var id = pageIds[i], content = bytes(ops);
      obj(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ' + xo + ' >> >> /Contents ' + (id + 1) + ' 0 R >>');
      obj(id + 1, [bytes('<< /Length ' + content.length + ' >>\nstream\n'), content, bytes('\nendstream')]);
    });
    var infoId = next + pageOps.length * 2;
    obj(infoId, '<< /Title ' + pdfStr(ansi(title)) + ' /Producer (PRIME Staff) >>');
    var xref = len, total = infoId + 1, x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var k = 1; k < total; k++) x += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
    push(bytes(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
    var out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  function pdf(receipts, logo) {
    if (!receipts || !receipts.length) throw new Error('No receipts.');
    return build(receipts.map(page), { Im1: { kind: 'jpeg', bytes: asBytes(logo) } },
      receipts.length === 1 ? 'Receipt ' + receipts[0].no + ' - ' + (receipts[0].name || '') : receipts.length + ' receipts');
  }
  /**
   * Cash at the desk: the receipt (same template) with the cash record number and both signatures.
   * c = the cash record { cashId, name, workbookName, studentNumber, at, amount, words, lines, receivedByName, status, test,
   *     receiptViews: the receipts made for this cash (full) }. Without a receipt (not in the workbook yet, override) the page shows
   *     the cash lines with "Receipt No." left as Not issued. sigs = { student: image|null, staff: image|null } (see build).
   */
  function cashPdf(c, logo, sigs) {
    sigs = sigs || {};
    var images = { Im1: { kind: 'jpeg', bytes: asBytes(logo) } };
    if (sigs.student) images.Im2 = sigs.student;
    if (sigs.staff) images.Im3 = sigs.staff;
    var day = torontoYmd(c.at), who = titleCase(c.workbookName || '') || c.name;
    var list = (c.receiptViews || []).length ? c.receiptViews : [{
      no: 'Not issued', studentId: c.studentNumber || '', name: who, program: '', date: day, title: c.studentNumber ? 'Tuition Receipt' : 'Receipt',
      template: 'new', lines: (c.lines || []).map(function (l) { return { desc: l.name, method: 'Cash', date: day, amount: Number(l.price) }; }),
      total: Number(c.amount), words: c.words, issuedBy: c.receivedByName || '' }];
    var extra = { recordNo: c.cashId, sigs: { student: !!sigs.student, staff: !!sigs.staff }, studentName: who, staffName: c.receivedByName || '' };
    var pages = list.map(function (r) {
      return page(Object.assign({}, r, { status: c.status === 'void' ? 'void' : r.status, test: c.test || r.test }), extra);
    });
    return build(pages, images, 'Cash record ' + c.cashId + ' - ' + who);
  }
  function torontoYmd(iso) {
    try { var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
      var g = function (t) { return p.filter(function (x) { return x.type === t; })[0].value; }; return g('year') + '-' + g('month') + '-' + g('day'); }
    catch (e) { return String(iso || '').slice(0, 10); }
  }

  /* ---------- PNG signatures -> PDF image (works in browsers, the Cloudflare worker and Node; needs (De)CompressionStream) ---------- */
  function streamThrough(u8, stream) {
    var blobRes = new Response(new Blob([u8]).stream().pipeThrough(stream));
    return blobRes.arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function b64ToBytes(b64) {
    if (typeof atob === 'function') { var s = atob(b64), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  /** data:image/png;base64,... -> {kind:'flate', w, h, bytes}: 8-bit RGB/RGBA, non-interlaced; alpha is laid on white. */
  function pngImage(dataUrl) {
    var m = /^data:image\/png;base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return Promise.reject(new Error('Not a PNG signature.'));
    var b = b64ToBytes(m[1]);
    if (b[0] !== 0x89 || b[1] !== 0x50) return Promise.reject(new Error('Not a PNG.'));
    var p = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0, idat = [], idatLen = 0;
    while (p + 8 <= b.length) {
      var len = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3], type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      var d = b.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') { w = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]; h = ((d[4] << 24) >>> 0) + (d[5] << 16) + (d[6] << 8) + d[7]; depth = d[8]; ctype = d[9]; inter = d[12]; }
      else if (type === 'IDAT') { idat.push(d); idatLen += d.length; }
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    var ch = ctype === 6 ? 4 : ctype === 2 ? 3 : 0;
    if (!w || !h || depth !== 8 || !ch || inter) return Promise.reject(new Error('Unsupported PNG.'));
    var z = new Uint8Array(idatLen), o = 0; idat.forEach(function (x) { z.set(x, o); o += x.length; });
    return streamThrough(z, new DecompressionStream('deflate')).then(function (raw) {
      var stride = w * ch, rgb = new Uint8Array(w * h * 3), prev = new Uint8Array(stride), cur = new Uint8Array(stride), q = 0;
      for (var y = 0; y < h; y++) {
        var f = raw[q++];
        for (var i = 0; i < stride; i++) {
          var x = raw[q++], a = i >= ch ? cur[i - ch] : 0, up = prev[i], c = i >= ch ? prev[i - ch] : 0, v;
          if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + up; else if (f === 3) v = x + ((a + up) >> 1);
          else { var pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
          cur[i] = v & 255;
        }
        for (var k = 0; k < w; k++) {
          var al = ch === 4 ? cur[k * 4 + 3] / 255 : 1;
          for (var cc = 0; cc < 3; cc++) rgb[(y * w + k) * 3 + cc] = Math.round(cur[k * ch + cc] * al + 255 * (1 - al));
        }
        var t = prev; prev = cur; cur = t;
      }
      return streamThrough(rgb, new CompressionStream('deflate')).then(function (zz) { return { kind: 'flate', w: w, h: h, bytes: zz }; });
    });
  }
  function cashFileName(c) {
    var safe = function (s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''); };
    return safe(c.cashId) + '_' + safe(titleCase(c.workbookName || c.name)) + '_' + safe(torontoParts(c.at).date) + (c.status === 'void' ? '_VOID' : '') + '.pdf';
  }

  var api = { pdf: pdf, cashPdf: cashPdf, pngImage: pngImage, cashFileName: cashFileName, money: money, longDate: longDate, fileName: function (rs) {
    var r = rs[0], safe = function (s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''); };
    return rs.length === 1 ? (r.studentId ? safe(r.studentId) + '_' : '') + safe(r.name) + '_' + safe(r.no) + '.pdf' : 'Receipts_' + rs.length + '_' + safe(r.date) + '.pdf';
  } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PrimeReceipt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
