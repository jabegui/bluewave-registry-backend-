const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// Draws the letterhead + report meta box that repeats at the top of
// every page, and returns the y position where the section body
// (subject/jurisdiction/table) should start.
function drawPageHeader(doc, { order, account, searchIndex, searchCount }) {
  const rightEdge = doc.page.width - doc.page.margins.right;
  const leftMargin = doc.page.margins.left;

  let headerTextX = leftMargin;
  try {
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, leftMargin, 45, { width: 36, height: 36 });
      headerTextX = leftMargin + 46;
    }
  } catch (err) {
    console.error('Could not render search result logo:', err.message);
  }

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#000000').text('Bluewave Registry', headerTextX, 48);
  doc.fontSize(9).font('Helvetica').fillColor('#555555')
    .text('Public Records & Lien Search', headerTextX)
    .text('bluewaveregistry.com | orders@bluewaveregistry.com', headerTextX)
    .fillColor('#000000');

  const metaBoxWidth = 230;
  const metaLabelX = rightEdge - metaBoxWidth;
  const metaValueX = metaLabelX + 105;
  let metaY = 48;
  const metaRows = [
    ['Report Date:', formatDate(new Date())],
    ['Order Ref:', order.reference_number],
    ['Requested By:', (account && (account.company_name || account.name)) || '—'],
    ['Search:', `${searchIndex} of ${searchCount}`],
  ];
  doc.fontSize(9);
  metaRows.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').text(label, metaLabelX, metaY, { width: 100 });
    doc.font('Helvetica').text(String(value), metaValueX, metaY, { width: metaBoxWidth - 105 });
    metaY += 15;
  });

  return 145;
}

// Draws one search's full section (subject/jurisdiction/index/status
// info block + filings table) starting right below the page header.
function drawSection(doc, { order, account, item, filings, searchIndex, searchCount }) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const leftMargin = doc.page.margins.left;
  const rightEdge = doc.page.width - doc.page.margins.right;

  const bodyTop = drawPageHeader(doc, { order, account, searchIndex, searchCount });

  doc.x = leftMargin;
  doc.y = bodyTop;
  const infoLabelWidth = 110;
  const infoRows = [
    ['Subject:', item.subject_name],
    ['Jurisdiction:', item.jurisdiction],
    ['Index Searched:', item.service_label || item.service_type],
    ['Searched Through:', formatDate(item.searched_through || new Date())],
    ['Order Status:', filings.length > 0 ? 'Filings found' : 'None of record'],
  ];
  infoRows.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').fontSize(9).text(label, leftMargin, doc.y, { width: infoLabelWidth, continued: true });
    doc.font('Helvetica').text(' ' + (value || '—'));
    doc.x = leftMargin;
  });

  doc.moveDown(1.2);
  const tableTop = doc.y;
  const colFileDate = leftMargin + 8;
  const colFileNum = leftMargin + 95;
  const colType = leftMargin + 235;
  const colParty = leftMargin + 400;
  const tableRight = rightEdge;

  doc.rect(leftMargin, tableTop, pageWidth, 24).fill('#e5e5e5');
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.5);
  doc.text('FILE DATE', colFileDate, tableTop + 8);
  doc.text('FILE #', colFileNum, tableTop + 8);
  doc.text('TYPE OF FILING', colType, tableTop + 8);
  doc.text('SECURED PARTY', colParty, tableTop + 8);

  const tableBoxTop = tableTop + 24;
  let rowY = tableBoxTop + 12;
  doc.font('Helvetica').fontSize(9);

  if (!filings || filings.length === 0) {
    doc.text('NONE OF RECORD', colFileDate, rowY);
    rowY += 20;
  } else {
    filings.forEach((f, idx) => {
      const partyLines = [f.secured_party, f.secured_party_location].filter(Boolean);
      const rowHeight = Math.max(
        16,
        doc.heightOfString(partyLines.join('\n') || '', { width: tableRight - colParty - 8 }) + 4
      );
      doc.text(formatDate(f.file_date), colFileDate, rowY, { width: colFileNum - colFileDate - 6 });
      doc.text(f.file_number || '—', colFileNum, rowY, { width: colType - colFileNum - 6 });
      doc.text(f.filing_type || '—', colType, rowY, { width: colParty - colType - 6 });
      doc.text(partyLines.join('\n') || '—', colParty, rowY, { width: tableRight - colParty - 8 });
      rowY += rowHeight + 8;
      if (idx < filings.length - 1) {
        doc.moveTo(leftMargin, rowY - 6).lineTo(tableRight, rowY - 6).strokeColor('#dddddd').stroke().strokeColor('#000000');
      }
    });
  }

  const tableBottom = Math.max(rowY + 10, tableBoxTop + 140);
  doc.rect(leftMargin, tableBoxTop, pageWidth, tableBottom - tableBoxTop).stroke();
}

// Runs after all section content has been drawn (using bufferPages so
// the total page count is known), and stamps the disclaimer/contact/
// page-number footer onto every page. Drawn in its own pass, with the
// bottom margin temporarily zeroed, so pdfkit's automatic pagination
// never mistakes this absolute-positioned text for overflow (the bug
// that caused blank extra pages in the original single-item version).
function drawFooters(doc, order) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const leftMargin = doc.page.margins.left;
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const footerY = doc.page.height - 110;
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#555555').text(
      'Bluewave Registry provides public records research and document retrieval. We are not a law firm and do not ' +
      'provide legal advice. Search results reflect the records available from each source as of the date searched; ' +
      'because indexing practices vary by jurisdiction and filing office, a report showing no record is not a guarantee ' +
      'that no record exists. Liability for any search is limited to the fee paid for that search.',
      leftMargin, footerY, { width: pageWidth, align: 'left' }
    );
    doc.fillColor('#000000');

    doc.fontSize(8).font('Helvetica-Bold').text(
      'Bluewave Registry  ★  bluewaveregistry.com  ★  orders@bluewaveregistry.com',
      leftMargin, doc.page.height - 70, { width: pageWidth, align: 'center' }
    );

    doc.fontSize(8).font('Helvetica').fillColor('#555555')
      .text(`Ref. ${order.reference_number}`, leftMargin, doc.page.height - 50, { width: pageWidth / 2, align: 'left' })
      .text(`Page ${i - range.start + 1} of ${range.count}`, leftMargin + pageWidth / 2, doc.page.height - 50, { width: pageWidth / 2, align: 'right' });
    doc.fillColor('#000000');

    doc.page.margins.bottom = originalBottomMargin;
  }
}

// Renders ONE combined PDF covering every in-scope search on an order
// -- each search (UCC / lien / county recorder) gets its own page, so
// staff only ever generate and share a single file per order instead
// of one per search. `sections` is an array of { item, filings }.
function renderCombinedSearchReportPdf({ order, account, sections }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    sections.forEach((section, idx) => {
      if (idx > 0) doc.addPage();
      drawSection(doc, {
        order,
        account,
        item: section.item,
        filings: section.filings,
        searchIndex: idx + 1,
        searchCount: sections.length,
      });
    });

    drawFooters(doc, order);
    doc.end();
  });
}

module.exports = { renderCombinedSearchReportPdf };

