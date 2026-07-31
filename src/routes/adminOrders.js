const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAdminKey } = require('../middleware/auth');
const { buildSearchMatrix } = require('../services/orderMatrix');

const router = express.Router();

function generateReferenceNumber() {
  return String(crypto.randomInt(100000, 999999));
}

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

// POST /api/internal/orders — staff creates an order manually, for
// requests that came in by email (or phone) instead of through the
// website's own order form. Finds an existing client account by
// email, or creates one on the spot (same as the email-intake account
// flow in accounts.js), then builds the order exactly like the public
// order flow does: subjects × services -> search_requests.
router.post('/orders', requireAdminKey, async (req, res) => {
  const {
    accountName, accountEmail, companyName, phone,
    billingAddressLine1, billingAddressLine2,
    billingCity, billingState, billingZip,
    matterName, subjects, services, contactEmail,
  } = req.body;

  if (!accountName || !accountEmail) {
    return res.status(400).json({ error: 'accountName and accountEmail are required.' });
  }
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return res.status(400).json({ error: 'At least one subject is required.' });
  }
  if (!Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ error: 'At least one service is required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let accountResult = await client.query(
      `SELECT id, email FROM accounts WHERE email = $1`,
      [accountEmail]
    );
    let account = accountResult.rows[0];

    if (!account) {
      const insertAccount = await client.query(
        `INSERT INTO accounts
           (name, email, company_name, phone,
            billing_address_line1, billing_address_line2,
            billing_city, billing_state, billing_zip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, email`,
        [accountName, accountEmail, companyName || null, phone || null,
         billingAddressLine1 || null, billingAddressLine2 || null,
         billingCity || null, billingState || null, billingZip || null]
      );
      account = insertAccount.rows[0];
    }

    const reference = generateReferenceNumber();
    const orderResult = await client.query(
      `INSERT INTO orders (account_id, reference_number, matter_name, contact_email, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id, reference_number, created_at`,
      [account.id, reference, matterName || null, contactEmail || accountEmail]
    );
    const order = orderResult.rows[0];

    const subjectIdByName = {};
    for (const subject of subjects) {
      const subjectResult = await client.query(
        `INSERT INTO search_subjects (order_id, name, entity_type, county)
         VALUES ($1, $2, $3, $4) RETURNING id, name`,
        [order.id, subject.name, subject.entityType || 'LLC', subject.county || null]
      );
      subjectIdByName[subject.name] = subjectResult.rows[0].id;
    }

    const matrix = buildSearchMatrix(subjects, services);
    for (const row of matrix) {
      await client.query(
        `INSERT INTO search_requests (subject_id, service_type, jurisdiction, fulfillment_tier, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [subjectIdByName[row.subjectName], row.serviceType, row.jurisdiction, row.fulfillmentTier]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      order: {
        id: order.id,
        referenceNumber: order.reference_number,
        matterName: matterName || null,
        createdAt: order.created_at,
        lineItemCount: matrix.length,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Manual order creation error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That reference number collided — please try again.' });
    }
    res.status(500).json({ error: 'Could not create the order.' });
  } finally {
    client.release();
  }
});

// PATCH /api/internal/orders/:reference/status — staff changes an
// order's overall status (e.g. Open -> Closed/Completed). This is
// separate from the per-line-item status updates below, which track
// individual search requests within the order.
router.patch('/orders/:reference/status', requireAdminKey, async (req, res) => {
  const { status } = req.body;
  const allowedStatuses = ['open', 'in_progress', 'completed', 'cancelled'];

  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const result = await db.query(
      `UPDATE orders SET status = $1 WHERE reference_number = $2 RETURNING id, reference_number, status`,
      [status, req.params.reference]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    res.json({ order: result.rows[0] });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Could not update order status.' });
  }
});

module.exports = router;
