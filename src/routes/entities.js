const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/entities/search?name=... — instant entity-name search
// against the ingested Sunbiz data. This backs the "instant tier"
// services (Certificate of Status pre-check, entity status lookup)
// without ever touching the live Sunbiz site.
router.get('/search', requireAuth, async (req, res) => {
  const { name } = req.query;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Provide at least 2 characters to search.' });
  }

  try {
    const result = await db.query(
      `SELECT id, document_number, entity_name, status, filing_type, fei_ein,
              principal_city, principal_state, filed_date
       FROM entities
       WHERE entity_name ILIKE $1
       ORDER BY entity_name
       LIMIT 25`,
      [`%${name.trim()}%`]
    );
    res.json({ entities: result.rows });
  } catch (err) {
    console.error('Entity search error:', err);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// GET /api/entities/:documentNumber — full detail incl. officers
router.get('/:documentNumber', requireAuth, async (req, res) => {
  try {
    const entityResult = await db.query(
      'SELECT * FROM entities WHERE document_number = $1',
      [req.params.documentNumber]
    );
    const entity = entityResult.rows[0];
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found in ingested Sunbiz data.' });
    }

    const officersResult = await db.query(
      'SELECT name, title, address FROM officers WHERE entity_id = $1',
      [entity.id]
    );

    res.json({ entity, officers: officersResult.rows });
  } catch (err) {
    console.error('Entity detail error:', err);
    res.status(500).json({ error: 'Could not load entity.' });
  }
});

module.exports = router;
