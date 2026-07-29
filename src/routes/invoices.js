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

module.exports = router;
