const express = require('express');
const db = require('../db');
const { requireAdminKey } = require('../middleware/auth');

const router = express.Router();

router.get('/orders', requireAdminKey, async (req, res) => {
    try {
          const result = await db.query(
                  `SELECT o.id, o.reference_number, o.matter_name, o.status, o.created_at,
                                a.name AS account_name, a.company_name, a.account_number, o.contact_email,
                                              COUNT(DISTINCT sr.id) AS total_items,
                                                            COUNT(DISTINCT sr.id) FILTER (WHERE sr.status = 'completed') AS completed_items,
                                                                          i.invoice_number, i.total_cents, i.status AS invoice_status
                                                                                 FROM orders o
                                                                                        LEFT JOIN accounts a ON a.id = o.account_id
                                                                                               LEFT JOIN search_subjects ss ON ss.order_id = o.id
                                                                                                      LEFT JOIN search_requests sr ON sr.subject_id = ss.id
                                                                                                             LEFT JOIN invoices i ON i.order_id = o.id
                                                                                                                    GROUP BY o.id, a.name, a.company_name, a.account_number, i.invoice_number, i.total_cents, i.status
                                                                                                                           ORDER BY o.created_at DESC`
                );
          res.json({ orders: result.rows });
    } catch (err) {
          console.error('List all orders error:', err);
          res.status(500).json({ error: 'Could not load orders.' });
    }
});

router.get('/orders/:reference', requireAdminKey, async (req, res) => {
    try {
          const orderResult = await db.query(
                  `SELECT o.*, a.name AS account_name, a.company_name, a.account_number
                         FROM orders o
                                LEFT JOIN accounts a ON a.id = o.account_id
                                       WHERE o.reference_number = $1`,
                  [req.params.reference]
                );
          const order = orderResult.rows[0];
          if (!order) {
                  return res.status(404).json({ error: 'Order not found.' });
          }

      const itemsResult = await db.query(
              `SELECT sr.id, sr.service_type, sr.jurisdiction, sr.fulfillment_tier, sr.status,
                            sr.searched_through, sr.result_summary, sr.unit_cost_cents, ss.name AS subject_name
                                   FROM search_requests sr
                                          JOIN search_subjects ss ON ss.id = sr.subject_id
                                                 WHERE ss.order_id = $1
                                                        ORDER BY ss.name, sr.service_type`,
              [order.id]
            );

      const invoiceResult = await db.query(
              `SELECT invoice_number, total_cents, status FROM invoices WHERE order_id = $1`,
              [order.id]
            );

      res.json({
              order,
              lineItems: itemsResult.rows,
              invoice: invoiceResult.rows[0] || null,
      });
    } catch (err) {
          console.error('Get order (admin) error:', err);
          res.status(500).json({ error: 'Could not load order.' });
    }
});

module.exports = router;
