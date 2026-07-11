# Bluewave Registry — Backend

A Node/Express + PostgreSQL backend implementing:

- **Account auth** — signup/login with bcrypt-hashed passwords and JWT sessions (replaces the plaintext demo storage in the frontend prototype)
- **Order management** — creating an order expands it into the full search matrix (subject × service × jurisdiction), matching the structure seen in real vendor search reports and invoices
- **Instant-tier entity lookups** — served from a local `entities` table, meant to be populated by the Sunbiz ingestion connector rather than live-querying the state site on every request
- **A Sunbiz bulk-data ingestion connector** — pulls Florida's public daily/quarterly corporate data files and upserts them into Postgres

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
npm run migrate        # creates all tables against DATABASE_URL
npm start               # starts the API on PORT (default 4000)
```

Requires a Postgres database. If you want fast partial-name entity search, also enable the trigram extension once, as a superuser:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

## Project layout

```
src/
  server.js              Express app entry point
  db.js                  Postgres connection pool
  schema.sql             Full database schema (run via `npm run migrate`)
  middleware/auth.js      JWT auth middleware + admin API key gate
  routes/
    auth.js               POST /signup, /login, GET /me
    orders.js             Order creation, listing, detail, internal status updates
    entities.js            Instant-tier entity search/detail
  services/
    orderMatrix.js         The service catalog + subject×service expansion logic
  connectors/
    sunbizIngest.js         FTP download + parse + upsert for Sunbiz bulk data
```

## API summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create an account |
| POST | `/api/auth/login` | — | Log in, get a JWT |
| GET | `/api/auth/me` | client | Check current session |
| GET | `/api/orders/services/catalog` | — | List available services |
| POST | `/api/orders` | client | Create an order (expands into search requests) |
| GET | `/api/orders` | client | List the account's orders |
| GET | `/api/orders/:reference` | client | Full order detail incl. line items & documents |
| PATCH | `/api/orders/internal/search-requests/:id` | admin key | Update a line item's status (staff/connector use) |
| GET | `/api/entities/search?name=` | client | Instant entity name search (from ingested Sunbiz data) |
| GET | `/api/entities/:documentNumber` | client | Entity detail + officers |

Client auth uses `Authorization: Bearer <token>`. Internal endpoints use an `x-admin-key` header instead — keep that key on your server/staff tooling only, never in the client-facing frontend.

## Honest caveats — read before treating this as production-ready

1. **The Sunbiz ingestion connector's field layout is a placeholder.** `FIELD_LAYOUT` in `sunbizIngest.js` is a reasonable guess at which fields exist and roughly where, based on what's publicly known about the data (entity name, document number, status, filing type, FEI/EIN, address, officers) — but the exact byte offsets are **not verified** against Sunbiz's actual record-layout specification. Get that spec from the [Data Downloads page](https://dos.fl.gov/sunbiz/other-services/data-downloads/) and correct the offsets before running this against real data — otherwise it will silently parse garbage.
2. **FTP host, path, and credentials need reconfirming.** The values in `.env.example` reflect what's publicly documented, but hosts and paths can change; verify before your first real run.
3. **CORS is wide open** (`app.use(cors())`) — restrict it to your actual frontend origin before deploying.
4. **No rate limiting, no request validation library** — this is a solid structural starting point, not a hardened production API. Add rate limiting (e.g. `express-rate-limit`) and stricter input validation (e.g. `zod` or `joi`) before going live.
5. **Officer records aren't ingested yet** — the schema has an `officers` table, but `sunbizIngest.js` only parses and upserts entity-level records in this starter. Officer/registered-agent data is typically a separate section of the same bulk file (or a related file) and needs its own parsing pass once the layout is confirmed.
6. **Document storage is a stub.** The `documents` table stores a `file_url`, but nothing here actually uploads files anywhere (e.g. S3). Wire that up once you have a real place to put retrieved PDFs.
7. **The frontend prototype still uses `window.storage`**, not this API. Connecting the two — replacing the demo signup/login/order calls in the website with real `fetch()` calls to this backend — is the natural next step.
