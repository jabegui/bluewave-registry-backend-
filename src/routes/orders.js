const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireAdminKey } = require('../middleware/auth');
const { buildSearchMatrix, SERVICE_CATALOG } = require('../services/orderMatrix');
const { sendEmail, orderConfirmationEmail, staffAlertEmail, STAFF_ALERT_ADDRESS } = require('../services/mailer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function generateReferenceNumber() {
  return String(crypto.randomInt(100000, 999999));
}

// Applies optional billing-info fields to a client's account. Used by
// both order-creation routes below so billing details entered on
// either order form keep the account's invoice info current — same
// pattern as the staff-entered manual order flow.
async function applyBillingUpdate(dbClient, accountId, body) {
  const {
    companyName, phone,
    billingAddressLine1, billingAddressLine2,
    billingCity, billingState, billingZip,
  } = body;

  if (!companyName && !phone && !billingAddressLine1 && !billingCity && !billingState && !billingZip) {
    return;
  }

  await dbClient.query(
    `UPDATE accounts SET
       company_name = COALESCE($1, company_name),
       phone = COALESCE($2, phone),
       billing_address_line1 = COALESCE($3, billing_address_line1),
       billing_address_line2 = COALESCE($4, billing_address_line2),
       billing_city = COALESCE($5, billing_city),
       billing_state = COALESCE($6, billing_state),
       billing_zip = COALESCE($7, billing_zip)
     WHERE id = $8`,
    [companyName || null, phone || null, billingAddressLine1 || null, billingAddressLine2 || null,
      billingCity || null, billingState || null, billingZip || null, accountId]
  );
}

router.get('/services/catalog', (req, res) => {
  const catalog = Object.entries(SERVICE_CATALOG).map(([key, val]) => ({
    key,
    label: val.label,
    tier: val.tier,
  }));
  res.json({ services: catalog });
});

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

    await applyBillingUpdate(client, req.account.id, req.body);

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

    const orderSummary = {
      id: order.id,
      referenceNumber: order.reference_number,
      matterName: matterName || null,
      createdAt: order.created_at,
      lineItemCount: matrix.length,
    };

    res.status(201).json({ order: orderSummary });

    sendEmail({ to: req.account.email, ...orderConfirmationEmail(orderSummary) });
    sendEmail({ to: STAFF_ALERT_ADDRESS, ...staffAlertEmail(orderSummary, req.account.email) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Order creation error:', err);
    res.status(500).json({ error: 'Could not create the order. Please try again.' });
  } finally {
    client.release();
  }
});

// POST /api/orders/custom — the "multi-subject / custom" order form.
// These requests are free-form (a pasted subject list and/or an
// uploaded document) rather than a structured subject x service
// matrix, so this creates a bare order that staff will turn into a
// real search ticket by hand, and attaches any uploaded files as
// order_files (uploaded_by='client') so staff can see exactly what
// the client sent. Must be declared before the '/:reference' route
// below so 'custom' as a path segment doesn't get swallowed by it —
// as a POST-only route on a different method it wouldn't collide
// anyway, but keeping it up top for clarity.
router.post('/custom', requireAuth, upload.array('files', 10), async (req, res) => {
  const { matterName, customerNotes, contactEmail } = req.body;

  if (!customerNotes && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Add a subject list or upload a document before submitting.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    await applyBillingUpdate(client, req.account.id, req.body);

    const reference = generateReferenceNumber();
    const orderResult = await client.query(
      `INSERT INTO orders (account_id, reference_number, matter_name, contact_email, status, customer_notes)
       VALUES ($1, $2, $3, $4, 'open', $5) RETURNING id, reference_number, created_at`,
      [req.account.id, reference, matterName || null, contactEmail || req.account.email, customerNotes || null]
    );
    const order = orderResult.rows[0];

    const files = req.files || [];
    for (const file of files) {
      await client.query(
        `INSERT INTO order_files (order_id, file_name, mime_type, file_size, file_data, uploaded_by, visible_to_client)
         VALUES ($1, $2, $3, $4, $5, 'client', true)`,
        [order.id, file.originalname, file.mimetype, file.size, file.buffer]
      );
    }

    await client.query('COMMIT');

    const orderSummary = {
      id: order.id,
      referenceNumber: order.reference_number,
      matterName: matterName || null,
      createdAt: order.created_at,
    };

    res.status(201).json({ order: orderSummary });

    sendEmail({ to: req.account.email, ...orderConfirmationEmail(orderSummary) });
    sendEmail({ to: STAFF_ALERT_ADDRESS, ...staffAlertEmail(orderSummary, req.account.email) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Custom order creation error:', err);
    res.status(500).json({ error: 'Could not submit the order. Please try again.' });
  } finally {
    client.release();
  }
});

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

// GET /api/orders/files/:fileId — authenticated download for a client's
// own order files. Declared before '/:reference' is irrelevant here
// since this is a distinct two-segment path, but kept near the other
// file route for readability.
router.get('/files/:fileId', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.file_name, f.mime_type, f.file_data
       FROM order_files f
       JOIN orders o ON o.id = f.order_id
       WHERE f.id = $1 AND o.account_id = $2 AND (f.uploaded_by = 'client' OR f.visible_to_client = true)`,
      [req.params.fileId, req.account.id]
    );
    const file = result.rows[0];
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name.replace(/"/g, '')}"`);
    res.send(file.file_data);
  } catch (err) {
    console.error('Client file download error:', err);
    res.status(500).json({ error: 'Could not download file.' });
  }
});

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

    const filesResult = await db.query(
      `SELECT id, file_name AS "fileName", mime_type AS "mimeType", file_size AS "fileSize", uploaded_at AS "uploadedAt"
       FROM order_files
       WHERE order_id = $1 AND (uploaded_by = 'client' OR visible_to_client = true)
       ORDER BY uploaded_at DESC`,
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
      files: filesResult.rows,
    });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Could not load order.' });
  }
});

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
