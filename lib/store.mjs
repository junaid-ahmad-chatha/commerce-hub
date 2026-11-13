import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const CHANNELS = ['amazon', 'ebay', 'shopify'];
const now = () => new Date().toISOString();
export class DomainError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min || value > 10000000) throw new DomainError(`${name} must be a whole number between ${min} and 10,000,000.`);
  return value;
};
const text = (value, name, max = 180) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new DomainError(`${name} is required (up to ${max} characters).`);
  return value.trim();
};
const channel = value => { if (!CHANNELS.includes(value)) throw new DomainError('Choose Amazon, eBay, or Shopify.'); return value; };

export function createStore(filename = ':memory:') {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      on_hand INTEGER NOT NULL CHECK(on_hand>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand),
      buffer INTEGER NOT NULL DEFAULT 0 CHECK(buffer>=0), price_cents INTEGER NOT NULL CHECK(price_cents>=0),
      category TEXT NOT NULL DEFAULT 'General', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listings (
      product_id TEXT NOT NULL REFERENCES products(id), channel TEXT NOT NULL,
      external_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(product_id,channel), UNIQUE(channel,external_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','shipped','cancelled')),
      payload TEXT NOT NULL, total_cents INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(channel,external_id)
    );
    CREATE TABLE IF NOT EXISTS order_lines (
      order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity>0), price_cents INTEGER NOT NULL,
      PRIMARY KEY(order_id,product_id)
    );
    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
      kind TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL,
      on_hand INTEGER NOT NULL, reserved INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), channel TEXT NOT NULL,
      version INTEGER NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      detail TEXT NOT NULL DEFAULT 'Waiting for a local simulation', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(product_id,channel,version)
    );`);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const product = id => {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!p) throw new DomainError('Product not found.', 404);
    return p;
  };
  const available = p => Math.max(0, p.on_hand - p.reserved - p.buffer);
  function movement(p, kind, delta, reason) {
    db.prepare('INSERT INTO movements(product_id,kind,delta,reason,on_hand,reserved,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(p.id, kind, delta, reason, p.on_hand, p.reserved, now());
  }
  function enqueue(p) {
    // A newer absolute quantity supersedes pending snapshots for this product.
    db.prepare("UPDATE jobs SET status='superseded',detail='Replaced by a newer stock version',updated_at=? WHERE product_id=? AND status IN ('queued','failed')").run(now(), p.id);
    for (const l of db.prepare('SELECT channel FROM listings WHERE product_id=?').all(p.id)) {
      db.prepare('INSERT OR IGNORE INTO jobs(id,product_id,channel,version,quantity,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), p.id, l.channel, p.version, available(p), now(), now());
    }
  }
  function createProduct(input) {
    const sku = text(input.sku, 'SKU', 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(sku)) throw new DomainError('SKU must use letters, numbers, dots, underscores, or hyphens.');
    const title = text(input.title, 'Product title');
    const qty = integer(input.onHand, 'On-hand stock');
    const buffer = integer(input.buffer ?? 0, 'Safety buffer');
    const price = integer(input.priceCents, 'Price in cents');
    const category = text(input.category ?? 'General', 'Category', 80);
    return transaction(() => {
      if (db.prepare('SELECT id FROM products WHERE sku=?').get(sku)) throw new DomainError('This SKU already exists.', 409);
      const id = randomUUID();
      db.prepare('INSERT INTO products(id,sku,title,on_hand,buffer,price_cents,category,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, sku, title, qty, buffer, price, category, now());
      const p = product(id); movement(p, 'opening', qty, 'Opening stock'); return p;
    });
  }
  function mapListing(id, input) {
    const name = channel(input.channel), externalId = text(input.externalId, 'Marketplace identifier', 120);
    return transaction(() => {
      const p = product(id), title = text(input.title ?? p.title, 'Listing title', 255);
      const conflict = db.prepare('SELECT product_id FROM listings WHERE channel=? AND external_id=?').get(name, externalId);
      if (conflict && conflict.product_id !== id) throw new DomainError('That marketplace identifier is already mapped to another product.', 409);
      db.prepare(`INSERT INTO listings(product_id,channel,external_id,title) VALUES(?,?,?,?)
        ON CONFLICT(product_id,channel) DO UPDATE SET external_id=excluded.external_id,title=excluded.title`).run(id, name, externalId, title);
      db.prepare('UPDATE products SET version=version+1 WHERE id=?').run(id); enqueue(product(id));
    });
  }
  function adjustStock(id, input) {
    if (!Number.isSafeInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 10000000) throw new DomainError('Enter a non-zero whole-number stock adjustment.');
    const reason = text(input.reason, 'Adjustment reason', 240);
    return transaction(() => {
      const p = product(id), next = p.on_hand + input.delta;
      if (next < p.reserved) throw new DomainError('On-hand stock cannot fall below the units reserved for open orders.', 409);
      integer(next, 'Resulting stock');
      db.prepare('UPDATE products SET on_hand=?,version=version+1 WHERE id=?').run(next, id);
      const updated = product(id); movement(updated, 'adjustment', input.delta, reason); enqueue(updated); return updated;
    });
  }
  function importOrder(input) {
    const name = channel(input.channel), externalId = text(input.externalId, 'Order reference', 120);
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw new DomainError('An order needs 1 to 100 lines.');
    const merged = new Map();
    for (const line of input.lines) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw new DomainError('Each order line must contain a SKU and quantity.');
      const sku = text(line.sku, 'Line SKU', 64).toUpperCase(), qty = integer(line.quantity, 'Order quantity', 1);
      merged.set(sku, integer((merged.get(sku) ?? 0) + qty, 'Combined order quantity', 1));
    }
    const canonical = JSON.stringify([...merged].sort(([a], [b]) => a.localeCompare(b)));
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM orders WHERE channel=? AND external_id=?').get(name, externalId);
      if (existing) {
        if (existing.payload !== canonical) throw new DomainError('This order reference already exists with different items. Review it instead of importing again.', 409);
        return { ...existing, duplicate: true };
      }
      const lines = [...merged].map(([sku, quantity]) => {
        const p = db.prepare('SELECT * FROM products WHERE sku=?').get(sku);
        if (!p) throw new DomainError(`Unknown SKU: ${sku}. Map or create this product first.`, 409);
        if (!db.prepare('SELECT 1 FROM listings WHERE product_id=? AND channel=?').get(p.id, name)) throw new DomainError(`${sku} has no ${name} listing mapping.`, 409);
        if (quantity > available(p)) throw new DomainError(`Not enough available stock for ${sku}. Available: ${available(p)}.`, 409);
        return { p, quantity };
      });
      const id = randomUUID(), total = lines.reduce((sum, l) => sum + l.p.price_cents * l.quantity, 0);
      if (!Number.isSafeInteger(total)) throw new DomainError('Order total is too large to represent accurately.');
      db.prepare('INSERT INTO orders(id,channel,external_id,status,payload,total_cents,created_at) VALUES(?,?,?,?,?,?,?)').run(id, name, externalId, 'reserved', canonical, total, now());
      for (const { p, quantity } of lines) {
        db.prepare('INSERT INTO order_lines(order_id,product_id,quantity,price_cents) VALUES(?,?,?,?)').run(id, p.id, quantity, p.price_cents);
        db.prepare('UPDATE products SET reserved=reserved+?,version=version+1 WHERE id=?').run(quantity, p.id);
        const updated = product(p.id); movement(updated, 'reservation', quantity, `Reserved for ${name} ${externalId}`); enqueue(updated);
      }
      return { id, duplicate: false };
    });
  }
  function transitionOrder(id, status) {
    if (!['shipped', 'cancelled'].includes(status)) throw new DomainError('Choose shipped or cancelled.');
    return transaction(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      if (!o) throw new DomainError('Order not found.', 404);
      if (o.status === status) return;
      if (o.status !== 'reserved') throw new DomainError('A completed order cannot be changed again.', 409);
      for (const line of db.prepare('SELECT * FROM order_lines WHERE order_id=?').all(id)) {
        db.prepare('UPDATE products SET reserved=reserved-?,on_hand=on_hand-?,version=version+1 WHERE id=?')
          .run(line.quantity, status === 'shipped' ? line.quantity : 0, line.product_id);
        const p = product(line.product_id);
        movement(p, status, status === 'shipped' ? -line.quantity : line.quantity, `${status === 'shipped' ? 'Shipped' : 'Released'} ${o.channel} ${o.external_id}`);
        enqueue(p);
      }
      db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
    });
  }
  function simulateSync(failChannel = null) {
    if (failChannel !== null) channel(failChannel);
    return transaction(() => {
      let succeeded = 0, failed = 0;
      for (const job of db.prepare("SELECT * FROM jobs WHERE status IN ('queued','failed')").all()) {
        const p = product(job.product_id);
        const stale = job.version !== p.version;
        const status = stale ? 'superseded' : job.channel === failChannel ? 'failed' : 'simulated';
        const detail = stale ? 'Replaced by a newer stock version' : status === 'failed' ? 'Simulated channel outage. Safe to retry.' : 'Local simulation only. No marketplace request was sent.';
        db.prepare('UPDATE jobs SET status=?,detail=?,updated_at=? WHERE id=?').run(status, detail, now(), job.id);
        if (status === 'simulated') succeeded++; if (status === 'failed') failed++;
      }
      return { succeeded, failed };
    });
  }
  function listingChecks(l, p) {
    const checks = [], limit = { amazon: 200, ebay: 80, shopify: 255 }[l.channel];
    if (l.title.length > limit) checks.push(`Title exceeds the starter ${limit}-character check.`);
    if (l.title.length < 25) checks.push('Consider a more specific title with product type and key attributes.');
    if (!l.description.trim()) checks.push('Add a factual product description.');
    if (available(p) === 0) checks.push('No stock available to sell.');
    return checks;
  }
  function saveListing(id, name, input) {
    channel(name); const title = text(input.title, 'Listing title', 255);
    if (typeof input.description !== 'string' || input.description.length > 5000) throw new DomainError('Description must contain at most 5,000 characters.');
    const result = db.prepare('UPDATE listings SET title=?,description=? WHERE product_id=? AND channel=?').run(title, input.description.trim(), id, name);
    if (!result.changes) throw new DomainError('Listing not found.', 404);
  }
  function snapshot() {
    const products = db.prepare('SELECT * FROM products ORDER BY created_at,id').all().map(p => ({ ...p, available: available(p), listings: db.prepare('SELECT * FROM listings WHERE product_id=? ORDER BY channel').all(p.id).map(l => ({ ...l, checks: listingChecks(l, p) })) }));
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC,id LIMIT 250').all().map(({ payload, ...o }) => ({ ...o, lines: db.prepare('SELECT ol.*,p.sku,p.title FROM order_lines ol JOIN products p ON p.id=ol.product_id WHERE order_id=?').all(o.id) }));
    return {
      mode: 'local', currency: 'USD', channels: CHANNELS.map(id => ({ id, connected: false, mode: 'simulation' })), products, orders,
      jobs: db.prepare('SELECT j.*,p.sku FROM jobs j JOIN products p ON p.id=j.product_id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 300').all(),
      movements: db.prepare('SELECT m.*,p.sku FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 100').all(),
      summary: {
        skus: products.length, available: products.reduce((sum, p) => sum + p.available, 0),
        reserved: products.reduce((sum, p) => sum + p.reserved, 0),
        lowStock: products.filter(p => p.available <= 5).length,
        openOrders: Number(db.prepare("SELECT COUNT(*) n FROM orders WHERE status='reserved'").get().n),
        shippedValue: Number(db.prepare("SELECT COALESCE(SUM(total_cents),0) n FROM orders WHERE status='shipped'").get().n),
        pendingJobs: Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','failed')").get().n)
      }
    };
  }
  function seedDemo() {
    if (db.prepare('SELECT COUNT(*) n FROM products').get().n) throw new DomainError('Sample data can only be loaded into an empty workspace.', 409);
    return transaction(() => {
      // Internal helpers use savepoints neither here nor elsewhere: seed directly in this transaction.
      const samples = [
        ['STUDIO-TOTE','Everyday canvas tote, natural cotton',42,3,2400,'Accessories'],
        ['CERAMIC-01','Stoneware coffee mug, warm sand',18,2,1850,'Home & living'],
        ['DESK-PAD','Felt desk pad, charcoal, 80 × 40 cm',8,2,3200,'Office'],
        ['LINEN-SET','Linen napkin set of four, olive',4,1,2800,'Home & living'],
        ['BOTTLE-500','Insulated water bottle, sage, 500 ml',26,3,2600,'Accessories'],
        ['NOTEBOOK-A5','A5 dotted notebook, recycled paper',35,2,1400,'Office']
      ];
      for (const [sku,title,onHand,buffer,price,category] of samples) {
        const id = randomUUID();
        db.prepare('INSERT INTO products(id,sku,title,on_hand,buffer,price_cents,category,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,sku,title,onHand,buffer,price,category,now());
        for (const name of CHANNELS) db.prepare('INSERT INTO listings(product_id,channel,external_id,title,description) VALUES(?,?,?,?,?)')
          .run(id,name,`sample-${name}-${sku.toLowerCase()}`,title,name === 'shopify' ? `${title}. Sample listing copy for this local workspace.` : '');
        const p = product(id); movement(p,'opening',onHand,'Sample opening stock'); enqueue(p);
      }
    });
  }
  return { db, createProduct, mapListing, adjustStock, importOrder, transitionOrder, simulateSync, saveListing, snapshot, seedDemo, close: () => db.close() };
}

