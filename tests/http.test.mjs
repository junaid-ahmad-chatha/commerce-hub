import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

test('local API rejects cross-origin writes and requires CSRF protection',async t=>{
  const {server}=createApp({filename:':memory:'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const state=await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.channels.every(c=>!c.connected),true);
  const post=(headers={})=>fetch(`${base}/api/demo`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'});
  assert.equal((await post()).status,403);
  assert.equal((await post({'x-csrf-token':state.csrf,Origin:'https://external.example'})).status,403);
  const result=await post({'x-csrf-token':state.csrf,Origin:base});assert.equal(result.status,200);
  assert.equal((await result.json()).state.products.length,6);
  assert.equal((await post({'x-csrf-token':state.csrf})).status,409);
  assert.equal((await fetch(`${base}/../package.json`)).status,404);
});

