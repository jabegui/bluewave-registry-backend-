const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdminKey } = require('../middleware/auth');
const { buildSearchMatrix, SERVICE_CATALOG } = require('../services/orderMatrix');

const router = express.Router();

function generateReferenceNumber() {
  // 6-digit reference number, e.g. "402917" — matches the style
  // used in the sample vendor reports this product is modeled on.
  return String(crypto.randomInt(100000, 999999));
}

// GET /api/services — the public service catalog, used by the
// frontend to render the ordering checkboxes without hardcoding them.
router.get('/services/catalog', (req, res) => {
  const catalog = Object.entries(SERVICE_CATALOG).map(([key, val]) => ({
    key,
    label: val.label,
    tier: val.tier,
  }));
  res.json({ services: catalog });
});

// POST /api/orders — create a new order for the logged-in account.
// Body: { matterName, subjects: [{name, entityType, county}], services: [serviceKey, ...] }
router.post('/', requireAuth, async (req, res) => {
  const { matterName, subjects, services } = req.body;

  if (!Array.isArray(subjects) || subjects.length === 0) {
    return res.status(400).json({ error: 'At least one subject is required.' });
  }
  if (!Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ error: 'At least one service is required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const reference = generateReferenceNumber();
    const orderResult = await client.query(
      `INSERT INTO orders (account_id, reference_number, matter_name, contact_email, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id, reference_number, created_at`,
      [req.account.id, reference, matterName || null, req.account.email]
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
    console.error('Order creation error:', err);
    res.status(500).json({ error: 'Could not create the order. Please try again.' });
  } finally {
    client.release();
  }
});

// GET /api/orders — list the logged-in account's orders (summary only)
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.id, o.reference_number, o.matter_name, o.status, o.created_at,
              COUNT(sr.id) AS total_items,
              COUNT(sr.id) FILTER (WHERE sr.status = 'completed') AS completed_items
       FROM orders o
       LEFT JOIN search_subjects ss ON ss.order_id = o.id
       LEFT JOIN search_requests sr ON sr.subject_id = ss.id
       WHERE o.account_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.account.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('List orders error:', err);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// GET /api/orders/:reference — full detail for one order: every
// subject, every search request line item, its status, and any
// attached documents ready for download.
router.get('/:reference', requireAuth, async (req, res) => {
  try {
    const orderResult = await db.query(
      `SELECT * FROM orders WHERE reference_number = $1 AND account_id = $2`,
      [req.params.reference, req.account.id]
    );
    const order = orderResult.rows[0];
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const itemsResult = await db.query(
      `SELECT sr.id, sr.service_type, sr.jurisdiction, sr.fulfillment_tier, sr.status,
              sr.searched_through, sr.result_summary, ss.name AS subject_name,
              (SELECT json_agg(json_build_object('id', d.id, 'fileName', d.file_name, 'fileUrl', d.file_url))
               FROM documents d WHERE d.search_request_id = sr.id) AS documents
       FROM search_requests sr
       JOIN search_subjects ss ON ss.id = sr.subject_id
       WHERE ss.order_id = $1
       ORDER BY ss.name, sr.service_type`,
      [order.id]
    );

    res.json({
      order: {
        referenceNumber: order.reference_number,
        matterName: order.matter_name,
        status: order.status,
        createdAt: order.created_at,
      },
      lineItems: itemsResult.rows,
    });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Could not load order.' });
  }
});

// PATCH /api/orders/internal/search-requests/:id — internal endpoint
// for staff tooling / connector scripts to update a line item's
// status once a search comes back. Not exposed to clients.
router.patch('/internal/search-requests/:id', requireAdminKey, async (req, res) => {
  const { status, resultSummary, searchedThrough } = req.body;
  const allowedStatuses = ['queued', 'in_progress', 'completed', 'no_record', 'error'];

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const result = await db.query(
      `UPDATE search_requests
       SET status = COALESCE($1, status),
           result_summary = COALESCE($2, result_summary),
           searched_through = COALESCE($3, searched_through),
           completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END
       WHERE id = $4
       RETURNING *`,
      [status, resultSummary, searchedThrough, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Search request not found.' });
    }
    res.json({ searchRequest: result.rows[0] });
  } catch (err) {
    console.error('Update search request error:', err);
    res.status(500).json({ error: 'Could not update search request.' });
  }
});

module.exports = router;
