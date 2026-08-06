const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requireAdminKey } = require('../middleware/auth');
const { buildSearchMatrix } = require('../services/orderMatrix');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function generateReferenceNumber() {
  return String(crypto.randomInt(100000, 999999));
}

const ITEM_STATUS_OPTIONS = ['queued', 'in_progress', 'completed', 'no_record', 'error'];

// GET /api/internal/orders -- the main dashboard list.
router.get('/orders', requireAdminKey, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.id, o.reference_number, o.matter_name, o.status, o.created_at,
              o.received_at, o.source_email, o.priority, o.due_date,
              a.name AS account_name, a.company_name, a.account_number, o.contact_email,
              COUNT(DISTINCT sr.id) AS total_items,
              COUNT(DISTINCT sr.id) FILTER (WHERE sr.status = 'completed') AS completed_items,
              COUNT(DISTINCT f.id) AS file_count,
              i.invoice_number, i.total_cents, i.status AS invoice_status,
              i.payment_status, i.payment_received_at
       FROM orders o
       LEFT JOIN accounts a ON a.id = o.account_id
       LEFT JOIN search_subjects ss ON ss.order_id = o.id
       LEFT JOIN search_requests sr ON sr.subject_id = ss.id
       LEFT JOIN order_files f ON f.order_id = o.id
       LEFT JOIN invoices i ON i.order_id = o.id
       GROUP BY o.id, a.name, a.company_name, a.account_number,
                i.invoice_number, i.total_cents, i.status, i.payment_status, i.payment_received_at
       ORDER BY o.received_at DESC`
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
              sr.searched_through, sr.result_summary, sr.unit_cost_cents, sr.completed_at,
              ss.name AS subject_name
       FROM search_requests sr
       JOIN search_subjects ss ON ss.id = sr.subject_id
       WHERE ss.order_id = $1
       ORDER BY ss.name, sr.service_type`,
      [order.id]
    );

    const invoiceResult = await db.query(
      `SELECT invoice_number, total_cents, status, payment_status, payment_received_at FROM invoices WHERE order_id = $1`,
      [order.id]
    );

    const filesResult = await db.query(
      `SELECT id, file_name, mime_type, file_size, uploaded_at FROM order_files WHERE order_id = $1 ORDER BY uploaded_at DESC`,
      [order.id]
    );

    res.json({
      order,
      lineItems: itemsResult.rows,
      invoice: invoiceResult.rows[0] || null,
      files: filesResult.rows,
    });
  } catch (err) {
    console.error('Get order (admin) error:', err);
    res.status(500).json({ error: 'Could not load order.' });
  }
});

// POST /api/internal/orders â staff creates an order manually, for
// requests that came in by email (or phone) instead of through the
// website's own order form. Finds an existing client account by
// email, or creates one on the spot (same as the email-intake account
// flow in accounts.js), then builds the order exactly like the public
// order flow does: subjects Ã services -> search_requests.
router.post('/orders', requireAdminKey, async (req, res) => {
  const {
    accountName, accountEmail, companyName, phone,
    billingAddressLine1, billingAddressLine2,
    billingCity, billingState, billingZip,
    matterName, subjects, services, contactEmail,
    receivedAt, sourceEmail, priority, dueDate, internalNotes,
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
    } else if (billingAddressLine1 || billingCity || billingState || billingZip) {
      // Existing client, but staff entered a billing address on this
      // order -- keep the account's billing info current so it's used
      // the next time an invoice is generated for them.
      await client.query(
        `UPDATE accounts SET
           billing_address_line1 = COALESCE($1, billing_address_line1),
           billing_address_line2 = COALESCE($2, billing_address_line2),
           billing_city = COALESCE($3, billing_city),
           billing_state = COALESCE($4, billing_state),
           billing_zip = COALESCE($5, billing_zip)
         WHERE id = $6`,
        [billingAddressLine1 || null, billingAddressLine2 || null,
          billingCity || null, billingState || null, billingZip || null, account.id]
      );
    }

    const reference = generateReferenceNumber();
    const orderResult = await client.query(
      `INSERT INTO orders
         (account_id, reference_number, matter_name, contact_email, status,
          received_at, source_email, priority, due_date, internal_notes)
       VALUES ($1, $2, $3, $4, 'open', COALESCE($5, now()), $6, COALESCE($7, 'normal'), $8, $9)
       RETURNING id, reference_number, created_at, received_at`,
      [account.id, reference, matterName || null, contactEmail || accountEmail,
        receivedAt || null, sourceEmail || null, priority || null, dueDate || null, internalNotes || null]
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
        receivedAt: order.received_at,
        lineItemCount: matrix.length,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Manual order creation error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That reference number collided â please try again.' });
    }
    res.status(500).json({ error: 'Could not create the order.' });
  } finally {
    client.release();
  }
});

// PATCH /api/internal/orders/:reference/status â staff changes an
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

// PATCH /api/internal/orders/:reference â edit intake/tracking fields
// that aren't the overall status: matter name, when it was actually
// received, who sent it (if by email), rush priority, due date, and
// staff-only internal notes.
router.patch('/orders/:reference', requireAdminKey, async (req, res) => {
  const { matterName, receivedAt, sourceEmail, priority, dueDate, internalNotes } = req.body;

  if (priority && !['normal', 'rush'].includes(priority)) {
    return res.status(400).json({ error: "priority must be 'normal' or 'rush'." });
  }

  try {
    const result = await db.query(
      `UPDATE orders SET
         matter_name = $1,
         received_at = COALESCE($2, received_at),
         source_email = $3,
         priority = COALESCE($4, priority),
         due_date = $5,
         internal_notes = $6
       WHERE reference_number = $7
       RETURNING *`,
      [matterName || null, receivedAt || null, sourceEmail || null,
        priority || null, dueDate || null, internalNotes || null, req.params.reference]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    res.json({ order: result.rows[0] });
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ error: 'Could not update order.' });
  }
});

// DELETE /api/internal/orders/:reference â permanently removes an
// order and everything attached to it (subjects, search requests,
// invoice + line items, uploaded files). Used to clear out test
// orders or duplicates entered by mistake.
router.delete('/orders/:reference', requireAdminKey, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `SELECT id FROM orders WHERE reference_number = $1`,
      [req.params.reference]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found.' });
    }

    await client.query(
      `DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE order_id = $1)`,
      [order.id]
    );
    await client.query(`DELETE FROM invoices WHERE order_id = $1`, [order.id]);
    await client.query(`DELETE FROM order_files WHERE order_id = $1`, [order.id]);
    await client.query(`DELETE FROM orders WHERE id = $1`, [order.id]);
    // search_subjects / search_requests cascade automatically from the
    // orders delete (ON DELETE CASCADE in schema.sql).

    await client.query('COMMIT');
    res.json({ deleted: true, referenceNumber: req.params.reference });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete order error:', err);
    res.status(500).json({ error: 'Could not delete order.' });
  } finally {
    client.release();
  }
});

// PATCH /api/internal/orders/:reference/items/:itemId â mark an
// individual search request (line item) queued / in progress /
// completed / no record / error. Drives the "X / Y items done"
// progress shown on the dashboard.
router.patch('/orders/:reference/items/:itemId', requireAdminKey, async (req, res) => {
  const { status, resultSummary, searchedThrough } = req.body;

  if (status && !ITEM_STATUS_OPTIONS.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ITEM_STATUS_OPTIONS.join(', ')}` });
  }

  try {
    const check = await db.query(
      `SELECT sr.id FROM search_requests sr
       JOIN search_subjects ss ON ss.id = sr.subject_id
       JOIN orders o ON o.id = ss.order_id
       WHERE o.reference_number = $1 AND sr.id = $2`,
      [req.params.reference, req.params.itemId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found on this order.' });
    }

    const result = await db.query(
      `UPDATE search_requests SET
         status = COALESCE($1, status),
         result_summary = COALESCE($2, result_summary),
         searched_through = COALESCE($3, searched_through),
         completed_at = CASE
           WHEN $1 = 'completed' THEN now()
           WHEN $1 IS NOT NULL THEN NULL
           ELSE completed_at
         END
       WHERE id = $4
       RETURNING *`,
      [status || null, resultSummary !== undefined ? resultSummary : null, searchedThrough || null, req.params.itemId]
    );
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error('Update item status error:', err);
    res.status(500).json({ error: 'Could not update item.' });
  }
});

// ---------------------------------------------------------------
// Order file attachments
// ---------------------------------------------------------------

router.post('/orders/:reference/files', requireAdminKey, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided.' });
  }
  try {
    const orderResult = await db.query(`SELECT id FROM orders WHERE reference_number = $1`, [req.params.reference]);
    const order = orderResult.rows[0];
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    const result = await db.query(
      `INSERT INTO order_files (order_id, file_name, mime_type, file_size, file_data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, file_name, mime_type, file_size, uploaded_at`,
      [order.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer]
    );
    res.status(201).json({ file: result.rows[0] });
  } catch (err) {
    console.error('Upload order file error:', err);
    res.status(500).json({ error: 'Could not upload file.' });
  }
});

router.get('/orders/:reference/files', requireAdminKey, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.id, f.file_name, f.mime_type, f.file_size, f.uploaded_at
       FROM order_files f
       JOIN orders o ON o.id = f.order_id
       WHERE o.reference_number = $1
       ORDER BY f.uploaded_at DESC`,
      [req.params.reference]
    );
    res.json({ files: result.rows });
  } catch (err) {
    console.error('List order files error:', err);
    res.status(500).json({ error: 'Could not load files.' });
  }
});

router.get('/files/:fileId', requireAdminKey, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT file_name, mime_type, file_data FROM order_files WHERE id = $1`,
      [req.params.fileId]
    );
    const file = result.rows[0];
    if (!file) {
      return res.status(404).json({ error: 'File not found.' });
    }
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/"/g, '')}"`);
    res.send(file.file_data);
  } catch (err) {
    console.error('Download order file error:', err);
    res.status(500).json({ error: 'Could not download file.' });
  }
});

router.delete('/files/:fileId', requireAdminKey, async (req, res) => {
  try {
    const result = await db.query(`DELETE FROM order_files WHERE id = $1 RETURNING id`, [req.params.fileId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found.' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete order file error:', err);
    res.status(500).json({ error: 'Could not delete file.' });
  }
});

module.exports = router;
