const express = require('express');
const db = require('../db');
const { requireAdminKey } = require('../middleware/auth');
const { generateInvoiceForOrder, getInvoiceByNumber } = require('../services/invoiceGenerator');
const { renderInvoicePdf } = require('../services/invoicePdf');

const router = express.Router();

router.post('/orders/:reference/invoice', requireAdminKey, async (req, res) => {
  try {
    const orderResult = await db.query(
      `SELECT id FROM orders WHERE reference_number = $1`,
      [req.params.reference]
      );
    const order = orderResult.rows[0];
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

  const result = await generateInvoiceForOrder(order.id);
    res.status(201).json(result);
  } catch (err) {
    console.error('Invoice generation error:', err);
    res.status(500).json({ error: err.message || 'Could not generate invoice.' });
  }
});

router.get('/invoices/:invoiceNumber', requireAdminKey, async (req, res) => {
  try {
    const result = await getInvoiceByNumber(req.params.invoiceNumber);
      if (!result) {
        return res.status(404).json({ error: 'Invoice not found.' });
      }
    res.json(result);
  } catch (err) {
    console.error('Get invoice error:', err);
    res.status(500).json({ error: 'Could not load invoice.' });
  }
});

// PATCH /api/internal/invoices/:invoiceNumber -- update invoice-level
// fields that aren't tied to a single line item (currently just
// staff-entered notes, shown on the PDF between the totals and the
// standard terms/disclaimer footer).
router.patch('/invoices/:invoiceNumber', requireAdminKey, async (req, res) => {
  const { notes } = req.body;
  try {
    const result = await db.query(
      `UPDATE invoices SET notes = $1 WHERE invoice_number = $2 RETURNING *`,
      [notes !== undefined ? notes : null, req.params.invoiceNumber]
      );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error('Update invoice error:', err);
    res.status(500).json({ error: 'Could not update invoice.' });
  }
});

router.get('/invoices/:invoiceNumber/pdf', requireAdminKey, async (req, res) => {
  try {
    const result = await getInvoiceByNumber(req.params.invoiceNumber);
    if (!result) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    renderInvoicePdf(res, result);
  } catch (err) {
    console.error('Render invoice PDF error:', err);
    res.status(500).json({ error: 'Could not render invoice PDF.' });
  }
});

// Recomputes and saves an invoice's subtotal/total from its current
// line items. Shared by the add/edit/delete line item routes below so
// the invoice total never drifts out of sync with its line items.
async function recalculateInvoiceTotals(client, invoiceId) {
  const totalsResult = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS subtotal FROM invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
    );
  const subtotal = Number(totalsResult.rows[0].subtotal);
  const updated = await client.query(
    `UPDATE invoices SET subtotal_cents = $1, total_cents = $1 WHERE id = $2 RETURNING *`,
    [subtotal, invoiceId]
    );
  return updated.rows[0];
}

// PATCH /api/internal/invoices/:invoiceNumber/line-items/:lineItemId
// Edits an existing line item's description, unit price, and/or
// quantity, then recalculates the invoice's total. Use this to
// correct pricing on an invoice before (or after) it goes out.
router.patch('/invoices/:invoiceNumber/line-items/:lineItemId', requireAdminKey, async (req, res) => {
  const { description, unitCostCents, quantity } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

  const invoiceResult = await client.query(
    `SELECT id FROM invoices WHERE invoice_number = $1`,
    [req.params.invoiceNumber]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found.' });
    }

  const existingResult = await client.query(
    `SELECT * FROM invoice_line_items WHERE id = $1 AND invoice_id = $2`,
    [req.params.lineItemId, invoice.id]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Line item not found on this invoice.' });
    }

  const newUnitCost = unitCostCents !== undefined ? unitCostCents : existing.unit_cost_cents;
    const newQuantity = quantity !== undefined ? quantity : existing.quantity;
    const newAmount = newUnitCost * newQuantity;

  const lineResult = await client.query(
    `UPDATE invoice_line_items
    SET description = COALESCE($1, description),
    unit_cost_cents = $2,
    quantity = $3,
    amount_cents = $4
    WHERE id = $5
    RETURNING *`,
    [description || null, newUnitCost, newQuantity, newAmount, existing.id]
    );

  const updatedInvoice = await recalculateInvoiceTotals(client, invoice.id);

  await client.query('COMMIT');
    res.json({ invoice: updatedInvoice, lineItem: lineResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update invoice line item error:', err);
    res.status(500).json({ error: 'Could not update line item.' });
  } finally {
    client.release();
  }
});

// POST /api/internal/invoices/:invoiceNumber/line-items
// Adds a new line item to an existing invoice (e.g. a rush fee, a
// service that wasn't part of the original order, or a manual
// correction line).
router.post('/invoices/:invoiceNumber/line-items', requireAdminKey, async (req, res) => {
  const { description, unitCostCents, quantity } = req.body;
  if (!description || unitCostCents === undefined) {
    return res.status(400).json({ error: 'description and unitCostCents are required.' });
  }

            const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

  const invoiceResult = await client.query(
    `SELECT id FROM invoices WHERE invoice_number = $1`,
    [req.params.invoiceNumber]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found.' });
    }

  const qty = quantity || 1;
    const sortResult = await client.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM invoice_line_items WHERE invoice_id = $1`,
      [invoice.id]
      );
    const nextSort = sortResult.rows[0].next_sort;

  const lineResult = await client.query(
    `INSERT INTO invoice_line_items
    (invoice_id, description, quantity, unit_cost_cents, amount_cents, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [invoice.id, description, qty, unitCostCents, unitCostCents * qty, nextSort]
    );

  const updatedInvoice = await recalculateInvoiceTotals(client, invoice.id);

  await client.query('COMMIT');
    res.status(201).json({ invoice: updatedInvoice, lineItem: lineResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Add invoice line item error:', err);
    res.status(500).json({ error: 'Could not add line item.' });
  } finally {
    client.release();
  }
});

// DELETE /api/internal/invoices/:invoiceNumber/line-items/:lineItemId
router.delete('/invoices/:invoiceNumber/line-items/:lineItemId', requireAdminKey, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

  const invoiceResult = await client.query(
    `SELECT id FROM invoices WHERE invoice_number = $1`,
    [req.params.invoiceNumber]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found.' });
    }

  const deleteResult = await client.query(
    `DELETE FROM invoice_line_items WHERE id = $1 AND invoice_id = $2 RETURNING id`,
    [req.params.lineItemId, invoice.id]
    );
    if (deleteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Line item not found on this invoice.' });
    }

  const updatedInvoice = await recalculateInvoiceTotals(client, invoice.id);

  await client.query('COMMIT');
    res.json({ invoice: updatedInvoice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete invoice line item error:', err);
    res.status(500).json({ error: 'Could not delete line item.' });
  } finally {
    client.release();
  }
});

// GET /api/internal/service-prices -- list default per-service pricing
// (the price used automatically the next time an order is invoiced).
router.get('/service-prices', requireAdminKey, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT service_type, label, default_price_cents FROM service_prices ORDER BY service_type`
      );
    res.json({ servicePrices: result.rows });
  } catch (err) {
    console.error('List service prices error:', err);
    res.status(500).json({ error: 'Could not load service prices.' });
  }
});

// PATCH /api/internal/service-prices/:serviceType -- update the default
// price and/or label used for a service going forward. Also accepts
// an optional newServiceType to correct a mismatched service_type key
// (e.g. if it doesn't match the key used in orderMatrix.js's
// SERVICE_CATALOG, the price won't be picked up when invoicing). This
// does NOT retroactively change already-generated invoices -- use the
// line-item routes above for that.
router.patch('/service-prices/:serviceType', requireAdminKey, async (req, res) => {
  const { defaultPriceCents, label, newServiceType } = req.body;
  try {
    const result = await db.query(
      `UPDATE service_prices
      SET default_price_cents = COALESCE($1, default_price_cents),
      label = COALESCE($2, label),
      service_type = COALESCE($3, service_type)
      WHERE service_type = $4
      RETURNING *`,
      [
        defaultPriceCents !== undefined ? defaultPriceCents : null,
        label || null,
        newServiceType || null,
        req.params.serviceType,
        ]
      );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Service price not found.' });
    }
    res.json({ servicePrice: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A service price with that service_type already exists.' });
    }
    console.error('Update service price error:', err);
    res.status(500).json({ error: 'Could not update service price.' });
  }
});

module.exports = router;
