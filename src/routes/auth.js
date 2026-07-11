const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are all required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existing = await db.query('SELECT id FROM accounts WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.query(
      'INSERT INTO accounts (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name.trim(), normalizedEmail, passwordHash]
    );

    const account = result.rows[0];
    const token = signToken(account);
    res.status(201).json({ token, account: { id: account.id, name: account.name, email: account.email } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const result = await db.query('SELECT * FROM accounts WHERE email = $1', [normalizedEmail]);
    const account = result.rows[0];

    // Deliberately vague error message — don't reveal whether the
    // email exists or the password was wrong.
    if (!account) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const match = await bcrypt.compare(password, account.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(account);
    res.json({ token, account: { id: account.id, name: account.name, email: account.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Could not log in right now. Please try again.' });
  }
});

// GET /api/auth/me — returns the logged-in account, used by the
// frontend on load to check whether an existing token is still valid.
router.get('/me', requireAuth, (req, res) => {
  res.json({ account: req.account });
});

module.exports = router;
