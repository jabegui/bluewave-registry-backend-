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

// Renders a UCC/lien-style search result report (subject, jurisdiction,
// index searched, and a filings table) in Bluewave's own branding and
// field set. Returns a Buffer (rather than streaming straight to a
// response) so the caller can both save it as an order_file and/or
// send it back directly.
function renderSearchResultPdf(data) {
  const { order, account, item, filings } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const leftMargin = doc.page.margins.left;
    const rightEdge = doc.page.width - doc.page.margins.right;

    // ---- Header: logo + wordmark (left), report meta (right) ----
    let headerTextX = leftMargin;
    try {
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, leftMargin, 45, { width: 36, height: 36 });
        headerTextX = leftMargin + 46;
      }
    } catch (err) {
      console.error('Could not render search result logo:', err.message);
    }

    doc.fontSize(18).font('Helvetica-Bold').text('Bluewave Registry', headerTextX, 48);
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
      ['Requested By:', account && (account.company_name || account.name) || '—'],
      ['Searched Through:', formatDate(item.searched_through || new Date())],
    ];
    doc.fontSize(9);
    metaRows.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, metaLabelX, metaY, { width: 100 });
      doc.font('Helvetica').text(String(value), metaValueX, metaY, { width: metaBoxWidth - 105 });
      metaY += 15;
    });

    // ---- Subject / jurisdiction block ----
    doc.x = leftMargin;
    doc.y = 145;
    const infoLabelWidth = 110;
    const infoRows = [
      ['Subject:', item.subject_name],
      ['Jurisdiction:', item.jurisdiction],
      ['Index Searched:', item.service_label || item.service_type],
      ['Order Status:', filings.length > 0 ? 'Filings found' : 'None of record'],
    ];
    infoRows.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').fontSize(9).text(label, leftMargin, doc.y, { width: infoLabelWidth, continued: true });
      doc.font('Helvetica').text(' ' + (value || '—'));
      doc.x = leftMargin;
    });

    // ---- Results table ----
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

    // ---- Footer: disclaimer + contact + page number ----
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
      .text(`Ref. ${order.reference_number}-${item.id}`, leftMargin, doc.page.height - 50, { width: pageWidth / 2, align: 'left' })
      .text('Page 1 of 1', leftMargin + pageWidth / 2, doc.page.height - 50, { width: pageWidth / 2, align: 'right' });
    doc.fillColor('#000000');

    doc.end();
  });
}

module.exports = { renderSearchResultPdf };

