const db = require('../db');

async function generateInvoiceForOrder(orderId) {
    const client = await db.pool.connect();
    try {
          await client.query('BEGIN');

      const orderResult = await client.query(
              `SELECT o.*, a.id AS account_id, a.name AS account_name,
                            a.company_name, a.billing_address_line1, a.billing_address_line2,
                                          a.billing_city, a.billing_state, a.billing_zip
                                                 FROM orders o
                                                        LEFT JOIN accounts a ON a.id = o.account_id
                                                               WHERE o.id = $1`,
              [orderId]
            );
          const order = orderResult.rows[0];
          if (!order) {
                  throw new Error(`Order ${orderId} not found.`);
          }

      const lineItemsResult = await client.query(
              `SELECT sr.id AS search_request_id, sr.service_type, sr.jurisdiction,
                            sr.unit_cost_cents, ss.name AS subject_name,
                                          sp.label AS service_label, sp.default_price_cents
                                                 FROM search_requests sr
                                                        JOIN search_subjects ss ON ss.id = sr.subject_id
                                                               LEFT JOIN service_prices sp ON sp.service_type = sr.service_type
                                                                      WHERE ss.order_id = $1
                                                                             ORDER BY ss.name, sr.service_type`,
              [orderId]
            );

      if (lineItemsResult.rows.length === 0) {
              throw new Error(`Order ${orderId} has no search requests to invoice.`);
      }

      const invoiceNumberResult = await client.query(`SELECT nextval('invoice_number_seq') AS n`);
          const invoiceNumber = `INV-${invoiceNumberResult.rows[0].n}`;

      const invoiceInsert = await client.query(
              `INSERT INTO invoices
                       (order_id, account_id, invoice_number, invoice_date, due_date,
                                 billing_name, billing_company, billing_address_line1, billing_address_line2,
                                           billing_city, billing_state, billing_zip, subtotal_cents, total_cents)
                                                  VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, $4, $5, $6, $7, $8, $9, $10, 0, 0)
                                                         RETURNING *`,
              [
                        orderId, order.account_id, invoiceNumber,
                        order.account_name, order.company_name,
                        order.billing_address_line1, order.billing_address_line2,
                        order.billing_city, order.billing_state, order.billing_zip,
                      ]
            );
          const invoice = invoiceInsert.rows[0];

      let subtotalCents = 0;
          let sortOrder = 0;
          const savedLineItems = [];

      for (const row of lineItemsResult.rows) {
              const unitCostCents = row.unit_cost_cents ?? row.default_price_cents ?? 0;
              const description = `${row.subject_name} - ${row.service_label || row.service_type} (${row.jurisdiction})`;
              const amountCents = unitCostCents;

            const lineResult = await client.query(
                      `INSERT INTO invoice_line_items
                                 (invoice_id, search_request_id, description, quantity, unit_cost_cents, amount_cents, sort_order)
                                          VALUES ($1, $2, $3, 1, $4, $5, $6)
                                                   RETURNING *`,
                      [invoice.id, row.search_request_id, description, unitCostCents, amountCents, sortOrder]
                    );
              savedLineItems.push(lineResult.rows[0]);
              subtotalCents += amountCents;
              sortOrder += 1;
      }

      const totalCents = subtotalCents;

      const updatedInvoice = await client.query(
              `UPDATE invoices SET subtotal_cents = $1, total_cents = $2 WHERE id = $3 RETURNING *`,
              [subtotalCents, totalCents, invoice.id]
            );

      await client.query('COMMIT');

      return {
              invoice: updatedInvoice.rows[0],
              lineItems: savedLineItems,
              order,
      };
    } catch (err) {
          await client.query('ROLLBACK');
          throw err;
    } finally {
          client.release();
    }
}

async function getInvoiceByNumber(invoiceNumber) {
    const invoiceResult = await db.query(
          `SELECT * FROM invoices WHERE invoice_number = $1`,
          [invoiceNumber]
        );
    const invoice = invoiceResult.rows[0];
    if (!invoice) return null;

  const lineItemsResult = await db.query(
        `SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
        [invoice.id]
      );

  const orderResult = await db.query(
        `SELECT reference_number, matter_name FROM orders WHERE id = $1`,
        [invoice.order_id]
      );

  return {
        invoice,
        lineItems: lineItemsResult.rows,
        order: orderResult.rows[0],
  };
}

module.exports = { generateInvoiceForOrder, getInvoiceByNumber };
