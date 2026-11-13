# Architecture and integration boundaries

## Current implementation

Browser → local HTTP API → synchronous SQLite transaction → stock ledger + order state + quantity job snapshots.

The stock ledger is authoritative for one seller-fulfilled warehouse. A product has one internal SKU and per-channel external identifiers; a mapping alone never proves marketplace access. The connection manager separately implements real authorization and read-only provider verification. Successful connections do not enable stock or listing writes.

The connection vault stores AES-256-GCM ciphertext and safe account metadata in separate SQLite tables. The encryption key stays in a local file or environment setting. OAuth attempts store hashed nonces with expiry and a browser-cookie hash. Registered callbacks can arrive via a configured HTTPS tunnel, but only return/login endpoints are accepted through the public address. They redirect to the initiating local origin, where the browser is verified before exchanging a code. Shopify callbacks additionally require HMAC and timestamp verification. Per-provider operations are serialized to avoid refresh rotation races and credential resurrection after disconnect.

An order is uniquely identified by channel and external reference. Sorted, merged SKU/quantity lines provide an idempotency fingerprint. A replay with the same items is a no-op; reusing a reference with different items is rejected. Validation covers every line before any reservation is committed. `BEGIN IMMEDIATE` serializes stock writes. SQL constraints also reject negative physical stock and reservations above on-hand stock.

Jobs contain an absolute target quantity and product version. Every stock mutation increments the product version and supersedes pending snapshots. Simulation refuses stale versions and reports `simulated`, never `synced`. This is not yet an external worker or a guarantee against ordering races in a live distributed system.

## Connector contract for the next phase

Keep each channel behind a connector with explicit capabilities:

- authorize/refresh/revoke credentials;
- import catalog pages and variant identifier mappings;
- read orders with durable polling cursors and normalized lifecycle events;
- set available quantity with per-account ordering and version checks;
- submit and poll asynchronous inventory feeds where necessary;
- read/write supported listing fields;
- fetch only metrics available to that seller and approved app.

Inbound events must be deduplicated before reserving stock. Unmapped SKUs and stock conflicts need durable exception records rather than discarded events. Maintain reconciliation schedules because webhooks and polling can miss or delay changes. Returns must restore stock only after a physical receipt decision, not merely a refund.

## Applying the reference projects

- inventory-sync-engine: field-specific routing, mapping, and deduplication are useful patterns. The permitted source snapshot is kept for review. Its legacy Shopify REST/basic-auth code and file-based deduplication are not connected to this app.
- OpenOMS: modular order, inventory, and operations boundaries informed the feature breakdown. Its application code is not a dependency.
- KubeRiva: reservation-first order lifecycle informed the workflow. Its source is not a dependency.
- OpenLinker: capability-based connector design informs the proposed integration boundary. Its source is not a dependency.

Do not combine whole applications with different databases and lifecycle rules. Use one core and deliberately port small, tested features with their applicable attribution and permission terms.

