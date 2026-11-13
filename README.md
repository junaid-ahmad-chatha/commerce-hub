# Commerce Hub

A local-first inventory and order workbench for Amazon, eBay, and Shopify operations. Includes real account authorization and read-only connection checks; marketplace writes and imports remain disabled.

## Run

Requires Node.js 24. Install the locked dependencies (PostgreSQL is used only in hosted mode).

```powershell
git clone https://github.com/junaid-ahmad-chatha/commerce-hub.git
cd commerce-hub
npm ci
npm start
```

Open http://localhost:3100. Load the sample catalog or add your own products. Sample data is opt-in and cannot overwrite an existing catalog. SQLite persists records in `data/commerce.sqlite`; closing the browser or restarting the server does not reset them.

## Connect real accounts

Open **Connections** at http://localhost:3100/#connections. Configure developer app credentials in the ignored `.env` file, register the displayed callbacks, and restart with `npm start`. Follow the [local connection guide](docs/CONNECTIONS.md) for Shopify OAuth/own-organization access, eBay Sandbox/Production OAuth, and Amazon public-app OAuth/private-app self-authorization. eBay and Amazon browser OAuth need a registered HTTPS callback, typically through a local tunnel.

Saved tokens are encrypted. Each connection is verified with a real read-only API call and supports refresh, retry, and local disconnect. Authorization does not enable catalog import, order import, publishing, or inventory writes.

## Implemented

- Master products, SKU validation, USD prices, and channel-specific identifier mappings.
- Physical on-hand stock, open-order reservations, and safety buffers.
- Manual multi-line order recording with transaction-wide validation and duplicate event protection.
- Shipment and cancellation transitions that cannot consume or release the same units twice.
- Audited stock corrections and inventory ledger.
- Versioned absolute-quantity jobs; new stock versions supersede older pending snapshots.
- Local sync simulation, a simulated eBay outage, and retry of failed jobs.
- Local listing title/description drafts and transparent starter content checks.
- CSV inventory export, search, filters, and responsive views.
- Local order counts and shipped value, with no invented traffic or ranking data.
- Amazon, eBay, and Shopify authorization, encrypted access/refresh tokens, API connection checks, and local disconnect.

Available stock is `max(0, on_hand - reserved - buffer)`. Shipping reduces physical stock and reserved units together. Cancellation releases the reservation without changing physical stock. A manual correction cannot reduce stock below existing reservations.

## Scope

This is a working prototype with local mode and a protected single-owner Heroku preview, not a multitenant SaaS. **Real authorization and read-only connection checks are supported; marketplace writes are disabled.** Identifiers and draft edits remain workspace records; stock simulations never call a marketplace. In local mode, app credentials stay in `.env`, tokens are encrypted in SQLite using a separate local key, and the server binds to loopback with host/origin/CSRF guards. An optional configured HTTPS tunnel accepts OAuth return/login routes only.

For Heroku, follow [the deployment guide](docs/HEROKU.md) and generate a source-only folder with `npm run package:heroku`. Hosted mode requires an owner password, HTTPS origin, stable encryption/session keys, and PostgreSQL. A row-locked PostgreSQL snapshot stores the small preview workspace durably; SQLite runs only in disposable request files. This 20 MB, serialized adapter is for owner testing. Customer access requires tenant isolation and normalized PostgreSQL tables. No Heroku resources are created by packaging.

The initial warehouse covers seller-fulfilled stock only, not Amazon FBA. One master currency (USD), one warehouse, one local user, fixed prices at order creation. Imported orders that cannot reserve stock are rejected for manual review; a production importer must persist those exceptions and alert the seller. Orders and jobs are displayed with limits of 250 and 300 respectively; performance tables are based on displayed orders. Summary inventory totals cover the whole catalog.

Content checks are starter heuristics, not guaranteed marketplace compliance, keyword search volume, ranking, or SEO effectiveness. They must become category/locale-aware before publishing.

## Project layout

```text
lib/store.mjs       SQLite schema, transactions, reservations, ledger, versioned jobs
lib/connections.mjs OAuth states, encrypted credentials, token refresh, provider read checks
lib/hosted.mjs      Protected owner preview and PostgreSQL snapshot persistence
server.mjs          Local HTTP server, API, host/origin/CSRF guards
public/             Dashboard: inventory, orders, listings, sync, performance
tests/              Behavioral tests for inventory and API protections
scripts/            Browser verification
docs/               Architecture and source provenance
```

## Verification

```powershell
node --test tests/*.test.mjs
```

Optional browser verification requires Playwright and Chrome/Edge. It uses an isolated in-memory database, exercises the UI, and saves screenshots under ignored `test-results/`.

```powershell
node scripts/verify-browser.mjs
```

## Integration sequence

1. Add authenticated workspaces and a normalized PostgreSQL tenant model before opening the hosted preview to customers.
2. Extend the implemented Shopify connection with GraphQL catalog/order import and inventory operations.
3. Extend the implemented eBay connection with SKU/offer validation, order import, and quantity updates.
4. Extend the implemented Amazon connection with seller-fulfilled inventory updates, feed completion tracking, and orders.
5. Introduce durable workers, deduplicated webhook/poll ingestion, rate limits, backoff, reconciliation, and persisted order exceptions. Revalidate job versions immediately before each external write.
6. Validate two accounts with duplicate events, concurrent orders, token expiry, API outages, and delayed updates before enabling live synchronization.
7. Add actual channel analytics and assisted listing optimization based on verified accessible data.

See [architecture](docs/ARCHITECTURE.md) and [source provenance](docs/SOURCES.md). No code from OpenOMS, KubeRiva, or OpenLinker has been copied into this implementation.

## Repository contents

This repository contains source, tests and setup documentation. Local credentials, databases, encryption keys, backups, generated packages and third-party reference snapshots are excluded. The previous Heroku deployment has been retired; running or hosting this code requires your own setup.

