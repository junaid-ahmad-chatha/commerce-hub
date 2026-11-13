import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';

function setup(t, quantity=10) {
  const store=createStore(); t.after(()=>store.close());
  const p=store.createProduct({sku:'TEST-01',title:'Cotton canvas tote bag',onHand:quantity,buffer:1,priceCents:2400});
  for(const channel of ['amazon','ebay','shopify']) store.mapListing(p.id,{channel,externalId:`${channel}-test`});
  return {store,id:p.id};
}
test('duplicate delivery reserves once; conflicting reuse of an order ID is rejected', t=>{
  const {store}=setup(t);
  const input={channel:'ebay',externalId:'ORDER-1',lines:[{sku:'TEST-01',quantity:2}]};
  store.importOrder(input); assert.equal(store.importOrder(input).duplicate,true);
  assert.equal(store.snapshot().products[0].reserved,2);
  assert.throws(()=>store.importOrder({...input,lines:[{sku:'TEST-01',quantity:3}]}),/different items/);
  assert.equal(store.snapshot().products[0].reserved,2);
});
test('shared stock cannot be reserved twice across marketplaces', t=>{
  const {store}=setup(t,5);
  store.importOrder({channel:'ebay',externalId:'A',lines:[{sku:'TEST-01',quantity:3}]});
  assert.throws(()=>store.importOrder({channel:'amazon',externalId:'B',lines:[{sku:'TEST-01',quantity:2}]}),/Not enough/);
  assert.equal(store.snapshot().orders.length,1);
  assert.equal(store.snapshot().products[0].available,1);
});
test('multi-line order failure rolls back every reservation', t=>{
  const {store}=setup(t);
  assert.throws(()=>store.importOrder({channel:'amazon',externalId:'A',lines:[{sku:'TEST-01',quantity:2},{sku:'MISSING',quantity:1}]}),/Unknown SKU/);
  assert.equal(store.snapshot().products[0].reserved,0);
  assert.equal(store.snapshot().orders.length,0);
});
test('repeated SKU lines combine before checking stock', t=>{
  const {store}=setup(t,5);
  assert.throws(()=>store.importOrder({channel:'shopify',externalId:'A',lines:[{sku:'TEST-01',quantity:3},{sku:'test-01',quantity:2}]}),/Not enough/);
  assert.equal(store.snapshot().products[0].reserved,0);
});
test('shipping consumes on-hand and reservation exactly once', t=>{
  const {store}=setup(t);
  const {id}=store.importOrder({channel:'ebay',externalId:'A',lines:[{sku:'TEST-01',quantity:2}]});
  const before=store.snapshot().products[0].available;
  store.transitionOrder(id,'shipped'); store.transitionOrder(id,'shipped');
  const p=store.snapshot().products[0]; assert.equal(p.on_hand,8); assert.equal(p.reserved,0); assert.equal(p.available,before);
  assert.throws(()=>store.transitionOrder(id,'cancelled'),/cannot be changed/);
});
test('cancellation releases stock without consuming physical inventory', t=>{
  const {store}=setup(t);
  const {id}=store.importOrder({channel:'ebay',externalId:'A',lines:[{sku:'TEST-01',quantity:2}]});
  store.transitionOrder(id,'cancelled'); store.transitionOrder(id,'cancelled');
  const p=store.snapshot().products[0]; assert.equal(p.on_hand,10); assert.equal(p.available,9); assert.equal(p.reserved,0);
});
test('stock corrections cannot consume units already reserved', t=>{
  const {store,id}=setup(t);
  store.importOrder({channel:'ebay',externalId:'A',lines:[{sku:'TEST-01',quantity:5}]});
  assert.throws(()=>store.adjustStock(id,{delta:-6,reason:'Count correction'}),/reserved/);
  assert.equal(store.snapshot().products[0].on_hand,10);
});
test('new stock supersedes old queued quantities; simulated failures can be retried', t=>{
  const {store,id}=setup(t);
  store.adjustStock(id,{delta:5,reason:'Received delivery'});
  const pending=store.snapshot().jobs.filter(j=>j.status==='queued');
  assert.equal(pending.length,3); assert.ok(pending.every(j=>j.quantity===14));
  assert.deepEqual(store.simulateSync('ebay'),{succeeded:2,failed:1});
  assert.deepEqual(store.simulateSync(),{succeeded:1,failed:0});
  assert.equal(store.snapshot().summary.pendingJobs,0);
  assert.ok(store.snapshot().jobs.filter(j=>j.status==='simulated').every(j=>j.detail.includes('No marketplace request')));
});
test('marketplace IDs cannot map to two products',t=>{
  const {store}=setup(t);
  const other=store.createProduct({sku:'OTHER',title:'Other product',onHand:2,priceCents:100});
  assert.throws(()=>store.mapListing(other.id,{channel:'ebay',externalId:'ebay-test'}),/already mapped/);
});
test('orders require an explicit mapping, not just a matching SKU',t=>{
  const store=createStore();t.after(()=>store.close());
  store.createProduct({sku:'UNMAPPED',title:'Unmapped sample product',onHand:2,priceCents:100});
  assert.throws(()=>store.importOrder({channel:'amazon',externalId:'A',lines:[{sku:'UNMAPPED',quantity:1}]}),/no amazon listing mapping/);
});
test('invalid numeric input is rejected without modifying inventory',t=>{
  const {store,id}=setup(t);
  assert.throws(()=>store.adjustStock(id,{delta:1.5,reason:'Invalid correction'}),/whole-number/);
  assert.throws(()=>store.createProduct({sku:'NEG',title:'Invalid product',onHand:-1,priceCents:100}),/whole number/);
});
test('data survives closing and reopening the database',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'commerce-persist-'));
  try {
    const file=path.join(dir,'data.sqlite'); let store=createStore(file);
    store.createProduct({sku:'PERSIST',title:'Persistent product',onHand:12,priceCents:500});store.close();
    store=createStore(file); assert.equal(store.snapshot().products[0].on_hand,12);store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

