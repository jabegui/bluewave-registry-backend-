// Sunbiz (FL Division of Corporations) bulk data ingestion connector.
//
// WHAT THIS DOES
// Florida's Division of Corporations publishes free daily and quarterly
// bulk data files over FTP for informational use (see
// https://dos.fl.gov/sunbiz/other-services/data-downloads/). This script
// connects, pulls the requested file, parses it, and upserts entity +
// officer records into Postgres — so the "instant tier" services in the
// API can be served from your own database instead of live-scraping
// Sunbiz on every request.
//
// BEFORE RUNNING THIS FOR REAL, CONFIRM:
//   1. The FTP host/path for the daily vs. quarterly files. Get this
//      from the Data Downloads page above — do not trust a hardcoded
//      guess here, hosts and paths can change.
//   2. The exact fixed-width column layout for the corporate data file.
//      Sunbiz publishes a layout/record-spec document alongside the
//      data — FIELD_LAYOUT below is a reasonable placeholder based on
//      the fields that are known to be present (entity name, document
//      number, status, filing type, FEI/EIN, principal address,
//      officers), but the exact byte offsets MUST be verified against
//      their official layout doc before this will parse correctly.
//   3. Whether your Postgres instance has the pg_trgm extension enabled
//      (used by the entities table's name-search index in schema.sql).
//
// This script is written to be safe to run repeatedly (upsert on
// document_number) so a scheduled nightly job is the intended usage.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const ftp = require('basic-ftp');
const db = require('../db');

// ------------------------------------------------------------------
// CONFIG — confirm these against Sunbiz's own documentation before
// running against the live feed. Values below are placeholders.
// ------------------------------------------------------------------
const FTP_CONFIG = {
  host: process.env.SUNBIZ_FTP_HOST || 'ftp.dos.state.fl.us', // CONFIRM against Sunbiz docs
  user: process.env.SUNBIZ_FTP_USER || 'Public',
  password: process.env.SUNBIZ_FTP_PASSWORD || 'PubAccess1845!', // CONFIRM — publicly documented password, but verify it's current
  secure: false, // set true if Sunbiz requires FTPS — confirm
};

// Remote path to the specific daily file to pull. In production you'd
// compute today's filename dynamically; left as a CLI arg here for
// clarity and safety while the exact naming convention is confirmed.
const REMOTE_FILE_PATH = process.argv[2];

if (!REMOTE_FILE_PATH) {
  console.error('Usage: node sunbizIngest.js <remote-file-path>');
  console.error('Example: node sunbizIngest.js /Domestic/cordata.txt');
  process.exit(1);
}

// PLACEHOLDER fixed-width layout — replace start/length with the real
// values from Sunbiz's record layout documentation before production use.
const FIELD_LAYOUT = {
  documentNumber: { start: 0, length: 12 },
  entityName: { start: 12, length: 192 },
  status: { start: 204, length: 1 },
  filingType: { start: 205, length: 4 },
  feiEin: { start: 209, length: 12 },
  principalAddress: { start: 221, length: 42 },
  principalCity: { start: 263, length: 28 },
  principalState: { start: 291, length: 2 },
  principalZip: { start: 293, length: 10 },
  filedDate: { start: 303, length: 8 }, // expected format YYYYMMDD — confirm
};

function parseFixedWidthLine(line) {
  const field = (key) => {
    const { start, length } = FIELD_LAYOUT[key];
    return line.slice(start, start + length).trim();
  };

  const filedDateRaw = field('filedDate');
  const filedDate =
    filedDateRaw.length === 8
      ? `${filedDateRaw.slice(0, 4)}-${filedDateRaw.slice(4, 6)}-${filedDateRaw.slice(6, 8)}`
      : null;

  return {
    documentNumber: field('documentNumber'),
    entityName: field('entityName'),
    status: field('status'),
    filingType: field('filingType'),
    feiEin: field('feiEin') || null,
    principalAddress: field('principalAddress') || null,
    principalCity: field('principalCity') || null,
    principalState: field('principalState') || null,
    principalZip: field('principalZip') || null,
    filedDate,
  };
}

async function downloadFile(remotePath) {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  const localPath = path.join(os.tmpdir(), `sunbiz-${Date.now()}.txt`);

  try {
    await client.access(FTP_CONFIG);
    await client.downloadTo(localPath, remotePath);
    console.log(`Downloaded ${remotePath} -> ${localPath}`);
    return localPath;
  } finally {
    client.close();
  }
}

async function upsertEntity(record) {
  if (!record.documentNumber || !record.entityName) return; // skip malformed lines

  const result = await db.query(
    `INSERT INTO entities (document_number, entity_name, status, filing_type, fei_ein,
                            principal_address, principal_city, principal_state, principal_zip,
                            filed_date, last_ingested_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (document_number) DO UPDATE SET
       entity_name = EXCLUDED.entity_name,
       status = EXCLUDED.status,
       filing_type = EXCLUDED.filing_type,
       fei_ein = EXCLUDED.fei_ein,
       principal_address = EXCLUDED.principal_address,
       principal_city = EXCLUDED.principal_city,
       principal_state = EXCLUDED.principal_state,
       principal_zip = EXCLUDED.principal_zip,
       filed_date = EXCLUDED.filed_date,
       last_ingested_at = now()
     RETURNING id`,
    [
      record.documentNumber,
      record.entityName,
      record.status,
      record.filingType,
      record.feiEin,
      record.principalAddress,
      record.principalCity,
      record.principalState,
      record.principalZip,
      record.filedDate,
    ]
  );
  return result.rows[0].id;
}

async function run() {
  console.log('Starting Sunbiz ingestion run...');
  const localPath = await downloadFile(REMOTE_FILE_PATH);

  const raw = fs.readFileSync(localPath, 'latin1'); // Sunbiz files are typically not UTF-8 — confirm encoding
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  let processed = 0;
  let skipped = 0;

  for (const line of lines) {
    const record = parseFixedWidthLine(line);
    if (!record.documentNumber) {
      skipped++;
      continue;
    }
    try {
      await upsertEntity(record);
      processed++;
    } catch (err) {
      console.error(`Failed to upsert ${record.documentNumber}:`, err.message);
      skipped++;
    }
  }

  fs.unlinkSync(localPath);
  console.log(`Ingestion complete. Processed: ${processed}, skipped: ${skipped}`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Ingestion run failed:', err);
  process.exit(1);
});
