const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set. Set a strong random value in .env before deploying.');
}

// Attaches req.account = { id, email, name } if a valid Bearer token
// is present. Returns 401 if the token is missing or invalid.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid authorization header.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.account = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

// Simple API-key gate for internal/admin endpoints (used by staff
// tooling and connector scripts to update search request status).
// This is intentionally separate from client auth above.
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  next();
}

function signToken(account) {
  return jwt.sign(
    { sub: account.id, email: account.email, name: account.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { requireAuth, requireAdminKey, signToken };
