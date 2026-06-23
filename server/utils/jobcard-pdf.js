// server/utils/jobcard-pdf.js
const PDFDocument = require('pdfkit');
const fs = require('fs');

function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function safe(text) {
  return (text === null || text === undefined || text === '') ? '—' : String(text);
}

/**
 * Generates the job card PDF and writes it to disk. Returns the absolute path.
 * Mirrors the inspection report's letterhead/list-style layout, but is built
 * for the opposite audience: operations briefing the onsite team on what
 * needs fixing and what materials/tools to bring.
 */
function generateJobCardPdf({ db, card, workOrder, outputPath }) {
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

  // ---- Letterhead (identical style to the inspection report) ----
  const headerTop = doc.y;
  if (companyLogo && fs.existsSync(companyLogo)) {
    try { doc.image(companyLogo, doc.page.margins.left, headerTop, { fit: [120, 60] }); } catch (e) {}
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
  doc.y = Math.max(doc.y, headerTop + 65);
  doc.x = doc.page.margins.left;

  doc.moveDown(2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(brandColor).lineWidth(2).stroke();
  doc.moveDown(1);

  // ---- Title ----
  doc.fontSize(20).fillColor('#111').font('Helvetica-Bold').text('Job Card');
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#555').font('Helvetica').text(`${safe(card.title)}`);
  doc.moveDown(1);

  // ---- Work order details ----
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#111').text('Work Order Details');
  doc.moveDown(0.3);
  doc.font('Helvetica').fillColor('#333');
  const details = [
    ['Reference', workOrder.reference],
    ['Client', workOrder.client_name],
    ['Site Address', workOrder.site_address],
    ['Assigned To', workOrder.assignee_name],
    ['Scheduled', workOrder.scheduled_at ? new Date(workOrder.scheduled_at).toLocaleString() : 'Not yet scheduled'],
    ['Priority', workOrder.priority]
  ];
  details.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(safe(value));
  });
  doc.moveDown(1);

  if (card.summary) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Overview of work');
    doc.font('Helvetica').fontSize(10).fillColor('#333').text(card.summary, { width: pageWidth });
    doc.moveDown(1);
  }

  // ---- Helper: a highlighted callout box (used for materials & special instructions) ----
  function renderInfoBox(heading, text, accentColor) {
    if (!text) return;
    doc.font('Helvetica-Bold').fontSize(10);
    const headingHeight = doc.heightOfString(heading, { width: pageWidth - 24 });
    doc.font('Helvetica').fontSize(10);
    const textHeight = doc.heightOfString(text, { width: pageWidth - 24 });
    const boxHeight = headingHeight + textHeight + 24;

    if (doc.y + boxHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();

    const boxTop = doc.y;
    doc.rect(doc.page.margins.left, boxTop, pageWidth, boxHeight).fill('#F4F6F8');
    doc.rect(doc.page.margins.left, boxTop, 4, boxHeight).fill(accentColor);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(accentColor)
      .text(heading, doc.page.margins.left + 16, boxTop + 10, { width: pageWidth - 32 });
    doc.font('Helvetica').fontSize(10).fillColor('#333')
      .text(text, doc.page.margins.left + 16, doc.y, { width: pageWidth - 32 });

    doc.y = boxTop + boxHeight + 16;
    doc.x = doc.page.margins.left;
  }

  renderInfoBox('General Materials & Tools Needed', card.general_materials, brandColor);
  renderInfoBox('Special Instructions / Site Access', card.special_instructions, '#b45309');

  // ---- Helper: a "Task" block — thumbnail(s) left, description + materials right ----
  function renderTaskBlock(task, index) {
    const leftColWidth = 130;
    const colGap = 20;
    const rightColX = doc.page.margins.left + leftColWidth + colGap;
    const rightColWidth = pageWidth - leftColWidth - colGap;
    const photos = Array.isArray(task.photos) ? task.photos : [];
    const title = `Task ${index + 1}${task.heading ? ': ' + task.heading : ''}`;

    doc.font('Helvetica-Bold').fontSize(12);
    const titleHeight = doc.heightOfString(title, { width: rightColWidth });
    doc.font('Helvetica').fontSize(10);
    const notesHeight = task.notes ? doc.heightOfString(task.notes, { width: rightColWidth }) : 0;
    doc.font('Helvetica-Bold').fontSize(9);
    const materialsLabelHeight = task.materials ? doc.heightOfString('Materials needed:', { width: rightColWidth }) : 0;
    doc.font('Helvetica').fontSize(9);
    const materialsHeight = task.materials ? doc.heightOfString(task.materials, { width: rightColWidth }) : 0;

    const rightHeight = titleHeight + 6 + notesHeight + (task.materials ? 10 + materialsLabelHeight + materialsHeight : 0);
    const leftHeight = photos.length * 126;
    const blockHeight = 16 + Math.max(rightHeight, leftHeight) + 16;

    if (doc.y + blockHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();

    const blockTop = doc.y;
    doc.moveTo(doc.page.margins.left, blockTop).lineTo(doc.page.margins.left + pageWidth, blockTop)
      .lineWidth(1.5).strokeColor(brandColor).stroke();
    const contentTop = blockTop + 14;

    let leftY = contentTop;
    photos.forEach((p) => {
      try { if (fs.existsSync(p.path)) doc.image(p.path, doc.page.margins.left, leftY, { fit: [leftColWidth, 120] }); } catch (e) {}
      leftY += 126;
    });

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(title, rightColX, contentTop, { width: rightColWidth });
    if (task.notes) {
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).fillColor('#333').text(task.notes, rightColX, doc.y, { width: rightColWidth });
    }
    if (task.materials) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#b45309').text('Materials needed:', rightColX, doc.y, { width: rightColWidth });
      doc.font('Helvetica').fontSize(9).fillColor('#333').text(task.materials, rightColX, doc.y, { width: rightColWidth });
    }

    doc.y = Math.max(leftY, doc.y) + 16;
    doc.x = doc.page.margins.left;
  }

  function renderPhotoGrid(photos) {
    if (!photos || !photos.length) return;
    const colWidth = (pageWidth - 20) / 2;
    let col = 0;
    let rowTop = doc.y;
    photos.forEach((p, idx) => {
      if (rowTop > doc.page.height - doc.page.margins.bottom - 220) { doc.addPage(); rowTop = doc.y; col = 0; }
      const x = doc.page.margins.left + col * (colWidth + 20);
      try { if (fs.existsSync(p.path)) doc.image(p.path, x, rowTop, { fit: [colWidth, 180], align: 'center' }); } catch (e) {}
      doc.fontSize(8).fillColor('#666').text(safe(p.caption) || `Photo ${idx + 1}`, x, rowTop + 185, { width: colWidth, align: 'center' });
      col++;
      if (col >= 2) { col = 0; rowTop += 210; } else { doc.y = rowTop; }
    });
    doc.y = rowTop + 210;
    doc.x = doc.page.margins.left;
  }

  let sections = [];
  try { sections = JSON.parse(card.sections || '[]'); } catch (e) { sections = []; }
  if (sections.length) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(`${sections.length} Task${sections.length === 1 ? '' : 's'}`);
    doc.moveDown(0.5);
  }
  sections.forEach((s, i) => renderTaskBlock(s, i));

  let photos = [];
  try { photos = JSON.parse(card.photos || '[]'); } catch (e) { photos = []; }
  if (photos.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text('Additional Photos');
    doc.moveDown(0.5);
    renderPhotoGrid(photos);
  }

  const range = doc.bufferedPageRange();
  const savedBottomMargin = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor('#999')
      .text(`${companyName} — Job Card ${workOrder.reference} — Page ${i + 1} of ${range.count}`,
        doc.page.margins.left, doc.page.height - 32, { width: pageWidth, align: 'center', lineBreak: false });
    doc.page.margins.bottom = savedBottomMargin;
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generateJobCardPdf };
