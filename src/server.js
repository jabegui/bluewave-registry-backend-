require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const entityRoutes = require('./routes/entities');
const accountRoutes = require('./routes/accounts');
const invoiceRoutes = require('./routes/invoices');

const app = express();

app.use(cors()); // tighten this to your real frontend origin before deploying
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/entities', entityRoutes);
app.use('/api/internal/accounts', accountRoutes);
app.use('/api/internal', invoiceRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Basic error handler as a last resort — route handlers should
// already catch and respond to their own errors.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Bluewave Registry API listening on port ${PORT}`);
});
