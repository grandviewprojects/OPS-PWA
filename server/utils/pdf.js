// server/utils/pdf.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function safe(text) {
  return (text === null || text === undefined || text === '') ? '—' : String(text);
}

/**
 * Generates the inspection report PDF and writes it to disk.
 * Returns the absolute path of the generated file.
 */
function generateInspectionPdf({ db, report, workOrder, inspector, outputPath }) {
  const companyName = getSetting(db, 'company_name', 'Your Company');
  const companyAddress = getSetting(db, 'company_address', '');
  const companyPhone = getSetting(db, 'company_phone', '');
  const companyEmail = getSetting(db, 'company_email', '');
  const companyWebsite = getSetting(db, 'company_website', '');
  const registrationNumber = getSetting(db, 'registration_number', '');
  const vatNumber = getSetting(db, 'vat_number', '');
  const companyLogo = getSetting(db, 'company_logo', '');
  const brandColor = getSetting(db, 'brand_color', '#1d4ed8');

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ---- Letterhead ----
  const headerTop = doc.y;
  if (companyLogo && fs.existsSync(companyLogo)) {
    try {
      doc.image(companyLogo, doc.page.margins.left, headerTop, { fit: [120, 60] });
    } catch (e) { /* ignore broken logo */ }
  }
  doc.fontSize(16).fillColor(brandColor).font('Helvetica-Bold')
    .text(companyName, doc.page.margins.left, headerTop, { align: 'right', width: pageWidth });
  doc.fontSize(9).fillColor('#444').font('Helvetica')
    .text([companyAddress, companyPhone, companyEmail, companyWebsite].filter(Boolean).join('  |  '),
      doc.page.margins.left, doc.y, { align: 'right', width: pageWidth });
  const regLine = [registrationNumber && `Reg. No: ${registrationNumber}`, vatNumber && `VAT No: ${vatNumber}`].filter(Boolean).join('   ');
  if (regLine) {
    doc.fontSize(8).fillColor('#777').font('Helvetica')
      .text(regLine, doc.page.margins.left, doc.y, { align: 'right', width: pageWidth });
  }

  doc.y = Math.max(doc.y, headerTop + 65); // clear the logo box too
  doc.x = doc.page.margins.left;

  doc.moveDown(2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(brandColor).lineWidth(2).stroke();
  doc.moveDown(1);

  // ---- Title ----
  doc.fontSize(20).fillColor('#111').font('Helvetica-Bold').text('Site Inspection Report');
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#555').font('Helvetica').text(`Report: ${safe(report.title)}`);
  doc.moveDown(1);

  // ---- Work order details box ----
  const detailsTop = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#111').text('Work Order Details', { underline: false });
  doc.moveDown(0.3);
  doc.font('Helvetica').fillColor('#333');

  const details = [
    ['Reference', workOrder.reference],
    ['Client', workOrder.client_name],
    ['Site Address', workOrder.site_address],
    ['Inspector', inspector ? inspector.name : ''],
    ['Inspection Date', report.finalized_at ? new Date(report.finalized_at).toLocaleString() : new Date().toLocaleString()],
    ['Priority', workOrder.priority]
  ];
  details.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(safe(value));
  });

  doc.moveDown(1);

  if (report.summary) {
    doc.font('Helvetica-Bold').fontSize(11).text('Summary');
    doc.font('Helvetica').fontSize(10).fillColor('#333').text(report.summary, { width: pageWidth });
    doc.moveDown(1);
  }

  // ---- Helper: draw an "Issue" block — thumbnail(s) on the left, title + notes on the right,
  // with a rule above it, matching the classic inspection-report list layout.
  function renderIssueBlock(finding, index) {
    const leftColWidth = 130;
    const colGap = 20;
    const rightColX = doc.page.margins.left + leftColWidth + colGap;
    const rightColWidth = pageWidth - leftColWidth - colGap;
    const photos = Array.isArray(finding.photos) ? finding.photos : [];
    const title = `Issue ${index + 1}${finding.heading ? ': ' + finding.heading : ''}`;

    // Estimate how tall this block will be so we can decide on a page break BEFORE drawing
    // anything (avoids splitting a photo from its text across two pages).
    doc.font('Helvetica-Bold').fontSize(12);
    const titleHeight = doc.heightOfString(title, { width: rightColWidth });
    doc.font('Helvetica').fontSize(10);
    const notesHeight = finding.notes ? doc.heightOfString(finding.notes, { width: rightColWidth }) : 0;
    const rightHeight = titleHeight + 6 + notesHeight;
    const leftHeight = photos.length * 126;
    const blockHeight = 16 + Math.max(rightHeight, leftHeight) + 16;

    if (doc.y + blockHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();

    const blockTop = doc.y;
    doc.moveTo(doc.page.margins.left, blockTop).lineTo(doc.page.margins.left + pageWidth, blockTop)
      .lineWidth(1.5).strokeColor(brandColor).stroke();

    const contentTop = blockTop + 14;

    // Left column — stacked photo thumbnail(s)
    let leftY = contentTop;
    photos.forEach((p) => {
      try {
        if (fs.existsSync(p.path)) {
          doc.image(p.path, doc.page.margins.left, leftY, { fit: [leftColWidth, 120] });
        }
      } catch (e) { /* skip broken image */ }
      leftY += 126;
    });

    // Right column — title + description
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(title, rightColX, contentTop, { width: rightColWidth });
    if (finding.notes) {
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).fillColor('#333').text(finding.notes, rightColX, doc.y, { width: rightColWidth });
    }

    doc.y = Math.max(leftY, doc.y) + 16;
    doc.x = doc.page.margins.left;
  }

  // ---- Helper: draw a 2-column photo grid starting at the current cursor position ----
  function renderPhotoGrid(photos) {
    if (!photos || !photos.length) return;
    const colWidth = (pageWidth - 20) / 2;
    let col = 0;
    let rowTop = doc.y;
    photos.forEach((p, idx) => {
      if (rowTop > doc.page.height - doc.page.margins.bottom - 220) {
        doc.addPage();
        rowTop = doc.y;
        col = 0;
      }
      const x = doc.page.margins.left + col * (colWidth + 20);
      try {
        if (fs.existsSync(p.path)) {
          doc.image(p.path, x, rowTop, { fit: [colWidth, 180], align: 'center' });
        }
      } catch (e) { /* skip broken image */ }
      doc.fontSize(8).fillColor('#666').text(safe(p.caption) || `Photo ${idx + 1}`, x, rowTop + 185, { width: colWidth, align: 'center' });
      col++;
      if (col >= 2) { col = 0; rowTop += 210; } else { doc.y = rowTop; }
    });
    doc.y = rowTop + 210;
    doc.x = doc.page.margins.left;
  }

  // ---- Issues / findings list ----
  let sections = [];
  try { sections = JSON.parse(report.sections || '[]'); } catch (e) { sections = []; }
  if (sections.length) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(`${sections.length} Issue${sections.length === 1 ? '' : 's'} Identified`);
    doc.moveDown(0.5);
  }
  sections.forEach((s, i) => renderIssueBlock(s, i));

  // ---- General / overview photos (not tied to a specific finding) ----
  let photos = [];
  try { photos = JSON.parse(report.photos || '[]'); } catch (e) { photos = []; }
  if (photos.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text('Additional Photos');
    doc.moveDown(0.5);
    renderPhotoGrid(photos);
  }

  // ---- Footer page numbers ----
  const range = doc.bufferedPageRange();
  const savedBottomMargin = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // avoid triggering an automatic page-break while drawing in the margin area
    doc.fontSize(8).fillColor('#999')
      .text(`${companyName} — Inspection Report ${workOrder.reference} — Page ${i + 1} of ${range.count}`,
        doc.page.margins.left, doc.page.height - 32,
        { width: pageWidth, align: 'center', lineBreak: false });
    doc.page.margins.bottom = savedBottomMargin;
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generateInspectionPdf };
