// src/services/mailer.js
// Sends transactional email via Resend (https://resend.com).
// Requires RESEND_API_KEY to be set in Railway's environment variables.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.MAIL_FROM || 'Bluewave Registry <orders@bluewaveregistry.com>';

// Staff alerts go to both addresses by default — orders@bluewaveregistry.com
// is currently experiencing intermittent delivery issues from Resend to
// Microsoft 365 (a new-sender trust/connection issue, not a config problem),
// so a Gmail fallback is included until that resolves. Override with a
// comma-separated list via STAFF_ALERT_EMAIL if needed.
const STAFF_ALERT_ADDRESS = process.env.STAFF_ALERT_EMAIL
  ? process.env.STAFF_ALERT_EMAIL.split(',').map(s => s.trim())
  : ['orders@bluewaveregistry.com', 'jabegui@gmail.com'];

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email send:', subject);
    return;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error('Resend API error:', response.status, body);
    }
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

function orderConfirmationEmail(order) {
  return {
    subject: `Order confirmed — REF. ${order.referenceNumber}`,
    html: `
      <p>Thanks for your order${order.matterName ? ` for <strong>${order.matterName}</strong>` : ''}.</p>
      <p>Reference number: <strong>${order.referenceNumber}</strong></p>
      <p>Line items: ${order.lineItemCount}</p>
      <p>You can track this order any time by logging into the Client Portal at
         <a href="https://bluewaveregistry.com">bluewaveregistry.com</a>.</p>
      <p>— Bluewave Registry</p>
    `,
  };
}

function staffAlertEmail(order, accountEmail) {
  return {
    subject: `New order — REF. ${order.referenceNumber}`,
    html: `
      <p>New order placed by <strong>${accountEmail}</strong>.</p>
      <p>Reference number: <strong>${order.referenceNumber}</strong></p>
      <p>Matter: ${order.matterName || '—'}</p>
      <p>Line items: ${order.lineItemCount}</p>
      <p>View it in the portal or database using the reference number above.</p>
    `,
  };
}

module.exports = { sendEmail, orderConfirmationEmail, staffAlertEmail, STAFF_ALERT_ADDRESS };
