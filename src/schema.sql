-- Bluewave Registry — database schema
-- Run this once against a fresh Postgres database to set up all tables.
-- psql "$DATABASE_URL" -f src/schema.sql

-- ============================================================
-- Accounts (client logins)
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Orders — one per client submission (à la carte or bulk/custom)
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id               SERIAL PRIMARY KEY,
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  reference_number TEXT NOT NULL UNIQUE,
  matter_name      TEXT,
  contact_email    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open', -- open | in_progress | completed | cancelled
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Search subjects — the entities/individuals named in an order
-- ============================================================
CREATE TABLE IF NOT EXISTS search_subjects (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'LLC', -- LLC | Corporation | Individual | Limited Partnership
  county      TEXT, -- optional, for county-level searches
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Search requests — one row per (subject x service x jurisdiction).
-- This is the actual "search matrix" line item, matching the
-- structure seen in real vendor search reports and invoices.
-- ============================================================
CREATE TABLE IF NOT EXISTS search_requests (
  id                 SERIAL PRIMARY KEY,
  subject_id         INTEGER NOT NULL REFERENCES search_subjects(id) ON DELETE CASCADE,
  service_type       TEXT NOT NULL, -- e.g. 'certificate_of_status', 'ucc_search', 'county_recorder_search'
  jurisdiction        TEXT NOT NULL, -- e.g. 'Secretary of State, FL' or 'Duval County Recorder, FL'
  fulfillment_tier   TEXT NOT NULL DEFAULT 'manual', -- instant | semi_automated | manual
  status             TEXT NOT NULL DEFAULT 'queued', -- queued | in_progress | completed | no_record | error
  searched_through   DATE,
  result_summary     TEXT, -- short human-readable summary, e.g. "3 filings" or "None of record"
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_search_requests_subject ON search_requests(subject_id);
CREATE INDEX IF NOT EXISTS idx_search_requests_status ON search_requests(status);

-- ============================================================
-- Documents — the actual retrieved files (reports, certificates,
-- UCC filings, etc) attached to a completed search request
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id                SERIAL PRIMARY KEY,
  search_request_id INTEGER NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  file_name         TEXT NOT NULL,
  file_url          TEXT NOT NULL, -- signed URL / storage path in production (e.g. S3 key)
  page_count        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Manual research queue — for search requests that can't be
-- fully automated (most county-level work, for now)
-- ============================================================
CREATE TABLE IF NOT EXISTS research_tasks (
  id                 SERIAL PRIMARY KEY,
  search_request_id  INTEGER NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  assigned_to        TEXT,
  due_date           DATE,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'queued', -- queued | in_progress | completed
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Entities — ingested from the Sunbiz (FL Division of Corporations)
-- daily/quarterly bulk data files. This is the "instant tier" data
-- source: certificate-of-status and entity-status lookups are
-- served straight from this table instead of live-querying Sunbiz.
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id               SERIAL PRIMARY KEY,
  document_number  TEXT NOT NULL UNIQUE, -- Sunbiz's own filing/document number
  entity_name      TEXT NOT NULL,
  status           TEXT, -- Active | Inactive | Dissolved | etc
  filing_type      TEXT, -- e.g. FLAL (FL LLC), FLPA, DOM-P, etc — confirm exact codes against Sunbiz layout doc
  fei_ein          TEXT,
  principal_address TEXT,
  principal_city   TEXT,
  principal_state  TEXT,
  principal_zip    TEXT,
  filed_date       DATE,
  last_ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities USING gin (entity_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_document_number ON entities(document_number);

-- Officers / registered agents attached to an entity
CREATE TABLE IF NOT EXISTS officers (
  id         SERIAL PRIMARY KEY,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  title      TEXT, -- e.g. MGR, MGRM, P, VP, S, T, RA (registered agent)
  address    TEXT
);

CREATE INDEX IF NOT EXISTS idx_officers_entity ON officers(entity_id);

-- Note: idx_entities_name uses trigram search for fast partial-name
-- matching. Requires the pg_trgm extension:
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Run that once as a superuser before this schema, or remove the
-- gin index above if trigram search isn't needed yet.
