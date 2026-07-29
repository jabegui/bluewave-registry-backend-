const PDFDocument = require('pdfkit');

function formatMoney(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(d) {
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function renderInvoicePdf(res, data) {
    const { invoice, lineItems, order } = data;
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
    doc.pipe(res);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(18).font('Helvetica-Bold').text('Bluewave Registry', { continued: false });
    doc.fontSize(9).font('Helvetica').fillColor('#555555')
      .text('Public Records & Lien Search')
      .text('bluewaveregistry.com  |  orders@bluewaveregistry.com')
      .fillColor('#000000');

  const boxTop = 50;
    const boxWidth = 220;
    const boxLeft = doc.page.width - doc.page.margins.right - boxWidth;
    doc.rect(boxLeft, boxTop, boxWidth, 70).stroke();
    doc.fontSize(8).font('Helvetica-Bold');
    const col1 = boxLeft + 6;
    const col2 = boxLeft + 115;
    doc.text('ACCOUNT NO.', col1, boxTop + 6, { width: 100 });
    doc.text('INVOICE NO.', col2, boxTop + 6, { width: 100 });
    doc.font('Helvetica').text(invoice.account_id ? `${invoice.account_id}` : '-', col1, boxTop + 18, { width: 100 });
    doc.text(invoice.invoice_number, col2, boxTop + 18, { width: 100 });

  doc.font('Helvetica-Bold').text('INVOICE DATE', col1, boxTop + 34, { width: 100 });
    doc.text('AMOUNT DUE', col2, boxTop + 34, { width: 100 });
    doc.font('Helvetica').text(formatDate(invoice.invoice_date), col1, boxTop + 46, { width: 100 });
    doc.font('Helvetica-Bold').text(formatMoney(invoice.total_cents), col2, boxTop + 46, { width: 100 });

  doc.moveDown(3);
    doc.y = 140;

  doc.font('Helvetica-Bold').fontSize(9).text('Billing Address:');
    doc.font('Helvetica').fontSize(9);
    if (invoice.billing_company) doc.text(invoice.billing_company);
    if (invoice.billing_name) doc.text(invoice.billing_name);
    if (invoice.billing_address_line1) doc.text(invoice.billing_address_line1);
    if (invoice.billing_address_line2) doc.text(invoice.billing_address_line2);
    if (invoice.billing_city || invoice.billing_state || invoice.billing_zip) {
          doc.text(`${invoice.billing_city || ''}, ${invoice.billing_state || ''} ${invoice.billing_zip || ''}`.trim());
    }
    if (!invoice.billing_name && !invoice.billing_company) {
          doc.fillColor('#999999').text('(no billing address on file)').fillColor('#000000');
    }

  doc.moveDown(1.5);

  doc.font('Helvetica-Bold').fontSize(9).text(`Order Date: `, { continued: true })
      .font('Helvetica').text(formatDate(invoice.invoice_date));
    doc.font('Helvetica-Bold').text(`Order No: `, { continued: true })
      .font('Helvetica').text(order.reference_number);
    if (order.matter_name) {
          doc.font('Helvetica-Bold').text(`Matter: `, { continued: true })
            .font('Helvetica').text(order.matter_name);
    }

  doc.moveDown(1);

  const tableTop = doc.y + 8;
    const colDesc = 50;
    const colQty = pageWidth - 140;
    const colUnit = pageWidth - 90;
    const colAmt = pageWidth - 20;

  doc.font('Helvetica-Bold').fontSize(9);
    doc.text('Description of Services', colDesc, tableTop);
    doc.text('Qty', 50 + colQty, tableTop, { width: 40, align: 'right' });
    doc.text('Unit Cost', 50 + colUnit - 40, tableTop, { width: 80, align: 'right' });
    doc.text('Amount', 50 + colAmt - 60, tableTop, { width: 80, align: 'right' });
    doc.moveTo(50, tableTop + 14).lineTo(50 + pageWidth, tableTop + 14).stroke();

  let y = tableTop + 20;
    doc.font('Helvetica').fontSize(9);
    for (const item of lineItems) {
          const rowHeight = doc.heightOfString(item.description, { width: colQty - 10 }) + 6;
          doc.text(item.description, colDesc, y, { width: colQty - 10 });
          doc.text(`${item.quantity}`, 50 + colQty, y, { width: 40, align: 'right' });
          doc.text(formatMoney(item.unit_cost_cents), 50 + colUnit - 40, y, { width: 80, align: 'right' });
          doc.text(formatMoney(item.amount_cents), 50 + colAmt - 60, y, { width: 80, align: 'right' });
          y += rowHeight;
          if (y > doc.page.height - 200) {
                  doc.addPage();
                  y = 50;
          }
    }

  doc.moveTo(50, y + 4).lineTo(50 + pageWidth, y + 4).stroke();
    y += 12;

  doc.font('Helvetica-Bold');
    doc.text('Subtotal', 50 + colUnit - 40, y, { width: 80, align: 'right' });
    doc.text(formatMoney(invoice.subtotal_cents), 50 + colAmt - 60, y, { width: 80, align: 'right' });
    y += 16;
    doc.text('Total Due', 50 + colUnit - 40, y, { width: 80, align: 'right' });
    doc.text(formatMoney(invoice.total_cents), 50 + colAmt - 60, y, { width: 80, align: 'right' });

  doc.y = Math.max(doc.y + 40, doc.page.height - 160);
    doc.font('Helvetica-Bold').fontSize(9).text('Terms: Due upon receipt.');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(7.5).fillColor('#555555').text(
          'Bluewave Registry provides public records research and document retrieval. We are not a law firm and do not ' +
          'provide legal advice. Search results reflect the records available from each source as of the date searched; ' +
          'because indexing practices vary by jurisdiction and filing office, a report showing no record is not a guarantee ' +
          'that no record exists. Liability for any search is limited to the fee paid for that search.',
      { width: pageWidth }
        );
    doc.moveDown(0.5);
    doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold')
      .text('Questions about this invoice? Contact orders@bluewaveregistry.com.');

  doc.end();
}

module.exports = { renderInvoicePdf };
