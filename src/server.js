require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const entityRoutes = require('./routes/entities');
const accountRoutes = require('./routes/accounts');
const invoiceRoutes = require('./routes/invoices');
const adminOrderRoutes = require('./routes/adminOrders');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/entities', entityRoutes);
app.use('/api/internal/accounts', accountRoutes);
app.use('/api/internal', invoiceRoutes);
app.use('/api/internal', adminOrderRoutes);

app.use((req, res) => {
    res.status(404).json({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Bluewave Registry API listening on port ${PORT}`);
});
