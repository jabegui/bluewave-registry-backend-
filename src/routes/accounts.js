const express = require('express');
const db = require('../db');
const { requireAdminKey } = require('../middleware/auth');

const router = express.Router();

// GET /api/internal/accounts/search?email=... - staff look up an
// existing account before creating a duplicate one for an
// email-intake client.
router.get('/search', requireAdminKey, async (req, res) => {
    const { email } = req.query;
    if (!email) {
          return res.status(400).json({ error: 'email query parameter is required.' });
    }
    try {
          const result = await db.query(
                  `SELECT id, account_number, name, email, company_name, phone,
                                billing_address_line1, billing_address_line2,
                                              billing_city, billing_state, billing_zip
                                                     FROM accounts WHERE email = $1`,
                  [email]
                );
          res.json({ account: result.rows[0] || null });
    } catch (err) {
          console.error('Account search error:', err);
          res.status(500).json({ error: 'Could not search accounts.' });
    }
});

// POST /api/internal/accounts - staff creates an account on the spot
// for a client who emailed in an order, before that client has ever
// set a portal password. account_number is assigned automatically by
// the database trigger, not here.
router.post('/', requireAdminKey, async (req, res) => {
    const {
          name, email, companyName, phone,
          billingAddressLine1, billingAddressLine2,
          billingCity, billingState, billingZip,
    } = req.body;

              if (!name || !email) {
                    return res.status(400).json({ error: 'name and email are required.' });
              }

              try {
                    const result = await db.query(
                            `INSERT INTO accounts
                                     (name, email, company_name, phone,
                                               billing_address_line1, billing_address_line2,
                                                         billing_city, billing_state, billing_zip)
                                                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                                                                       RETURNING id, account_number, name, email, company_name`,
                            [name, email, companyName || null, phone || null,
                                    billingAddressLine1 || null, billingAddressLine2 || null,
                                    billingCity || null, billingState || null, billingZip || null]
                          );
                    res.status(201).json({ account: result.rows[0] });
              } catch (err) {
                    if (err.code === '23505') {
                            return res.status(409).json({ error: 'An account with this email already exists.' });
                    }
                    console.error('Account creation error:', err);
                    res.status(500).json({ error: 'Could not create account.' });
              }
});

// PATCH /api/internal/accounts/:id - update billing info on an
// existing account (e.g. filling in company/address details later).
router.patch('/:id', requireAdminKey, async (req, res) => {
    const {
          companyName, phone,
          billingAddressLine1, billingAddressLine2,
          billingCity, billingState, billingZip,
    } = req.body;

               try {
                     const result = await db.query(
                             `UPDATE accounts
                                    SET company_name = COALESCE($1, company_name),
                                               phone = COALESCE($2, phone),
                                                          billing_address_line1 = COALESCE($3, billing_address_line1),
                                                                     billing_address_line2 = COALESCE($4, billing_address_line2),
                                                                                billing_city = COALESCE($5, billing_city),
                                                                                           billing_state = COALESCE($6, billing_state),
                                                                                                      billing_zip = COALESCE($7, billing_zip)
                                                                                                             WHERE id = $8
                                                                                                                    RETURNING id, account_number, name, email, company_name`,
                             [companyName, phone, billingAddressLine1, billingAddressLine2,
                                     billingCity, billingState, billingZip, req.params.id]
                           );
                     if (result.rows.length === 0) {
                             return res.status(404).json({ error: 'Account not found.' });
                     }
                     res.json({ account: result.rows[0] });
               } catch (err) {
                     console.error('Account update error:', err);
                     res.status(500).json({ error: 'Could not update account.' });
               }
});

module.exports = router;
