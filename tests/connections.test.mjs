import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createConnections, normalizeShop, loadTokenKey, encryptTokens, decryptTokens } from '../lib/connections.mjs';
import { createApp } from '../server.mjs';
import { request as httpRequest } from 'node:http';

const env={LOCAL_APP_ORIGIN:'http://localhost:3100',OAUTH_CALLBACK_ORIGIN:'https://callback.example',SHOPIFY_CLIENT_ID:'shop-client',SHOPIFY_CLIENT_SECRET:'shop-secret',EBAY_CLIENT_ID:'ebay-client',EBAY_CLIENT_SECRET:'ebay-secret',EBAY_RUNAME:'test-runame',EBAY_ENVIRONMENT:'sandbox',AMAZON_CLIENT_ID:'amazon-client',AMAZON_CLIENT_SECRET:'amazon-secret',AMAZON_APPLICATION_ID:'amzn1.sellerapps.app.test',AMAZON_DRAFT:'true'};
const browser='a'.repeat(64);
function requestWithHost(url,headers) {
  return new Promise((resolve,reject)=>{
    const request=httpRequest(url,{headers},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    });request.on('error',reject);request.end();
  });
}
function fixture(t,{override={},fetchOverride}={}) {
  const store=createStore(),requests=[];let time=Date.now(),tokenNumber=0;
  const transport=async(url,options={})=>{
    requests.push({url,options});if(fetchOverride){const result=await fetchOverride(url,options);if(result)return result;}
    if(url.includes('access_token')||url.includes('/oauth2/token')||url.includes('/auth/o2/token')) {
      tokenNumber++;return Response.json({access_token:`access-${tokenNumber}`,refresh_token:`refresh-${tokenNumber}`,expires_in:3600,refresh_token_expires_in:86400,scope:'read_products,read_inventory'});
    }
    if(url.includes('/graphql.json'))return Response.json({data:{shop:{id:'gid://shopify/Shop/1',name:'Example Shop',myshopifyDomain:'example.myshopify.com',currencyCode:'USD'}}});
    if(url.includes('/privilege'))return Response.json({sellerRegistrationCompleted:true});
    if(url.includes('/marketplaceParticipations'))return Response.json({payload:[{marketplace:{id:'US',name:'United States'},participation:{isParticipating:true}}]});
    throw new Error(`Unmocked request ${url}`);
  };
  const connections=createConnections({db:store.db,env:{...env,...override},fetchImpl:transport,clock:()=>time});
  t.after(()=>store.close());
  return {store,connections,requests,advance:ms=>time+=ms,time:()=>time};
}
function begin(connections,name='shopify') {
  const result=connections.start(name,{shop:'example.myshopify.com'},browser,'http://localhost:3100');
  const url=new URL(result.authorizationUrl);return {url,state:url.searchParams.get('state')};
}
function shopParams(state,time=Date.now(),extra={}) {
  const params=new URLSearchParams({code:'test-code',shop:'example.myshopify.com',state,timestamp:String(Math.floor(time/1000)),...extra});
  const message=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('&');
  params.set('hmac',createHmac('sha256',env.SHOPIFY_CLIENT_SECRET).update(message).digest('hex'));return params;
}
test('credentials are authenticated ciphertext; provider swapping and tampering fail',()=>{
  const key=randomBytes(32),data={accessToken:'access-secret',refreshToken:'refresh-secret'};
  const encrypted=encryptTokens(key,'amazon',data);
  assert.ok(!encrypted.includes('secret'));assert.deepEqual(decryptTokens(key,'amazon',encrypted),data);
  assert.throws(()=>decryptTokens(key,'ebay',encrypted),/cannot be decrypted/);
  const bytes=Buffer.from(encrypted,'base64');bytes[30]^=1;
  assert.throws(()=>decryptTokens(key,'amazon',bytes.toString('base64')),/cannot be decrypted/);
});
test('generated key persists, and invalid explicitly supplied keys fail',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'commerce-key-'));
  try{assert.deepEqual(loadTokenKey(dir),loadTokenKey(dir));assert.throws(()=>loadTokenKey(null,'invalid'),/32 random bytes/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('shop domains cannot target custom hosts, ports, paths, or credentials',()=>{
  assert.equal(normalizeShop('https://Example.myshopify.com/'),'example.myshopify.com');
  for(const shop of ['127.0.0.1','evil.example','example.myshopify.com.evil.example','a@shop.myshopify.com','shop.myshopify.com:443','shop.myshopify.com/path'])assert.throws(()=>normalizeShop(shop));
});
test('missing configuration returns actionable fields without secret values',t=>{
  const {connections}=fixture(t,{override:{SHOPIFY_CLIENT_SECRET:'',EBAY_RUNAME:'',OAUTH_CALLBACK_ORIGIN:''}});
  const info=connections.list();assert.ok(info.find(c=>c.id==='shopify').missing.includes('SHOPIFY_CLIENT_SECRET'));
  assert.ok(info.find(c=>c.id==='ebay').missing.includes('OAUTH_CALLBACK_ORIGIN (HTTPS)'));
  assert.throws(()=>begin(connections),/Configure SHOPIFY_CLIENT_SECRET/);
  assert.ok(!JSON.stringify(info).includes('amazon-secret'));
});
test('OAuth URLs use configured environments, RuName, state, and Amazon draft flag',t=>{
  const {connections}=fixture(t);
  const ebay=begin(connections,'ebay');assert.equal(ebay.url.hostname,'auth.sandbox.ebay.com');assert.equal(ebay.url.searchParams.get('redirect_uri'),'test-runame');
  const amazon=begin(connections,'amazon');assert.equal(amazon.url.hostname,'sellercentral.amazon.com');assert.equal(amazon.url.searchParams.get('version'),'beta');
  const shop=begin(connections);assert.equal(shop.url.searchParams.get('redirect_uri'),'https://callback.example/oauth/shopify/return');
});
test('Shopify OAuth verifies the account and never exposes its tokens',async t=>{
  const {connections,store,requests,time}=fixture(t);const {state}=begin(connections);
  const params=shopParams(state,time()),relay=new URL(connections.relay('shopify',params));
  assert.equal(relay.origin,'http://localhost:3100');assert.equal(relay.pathname,'/oauth/shopify/complete');
  await connections.complete('shopify',params,browser);
  const c=connections.list().find(c=>c.id==='shopify');assert.equal(c.connected,true);assert.equal(c.accountLabel,'Example Shop');
  assert.ok(!JSON.stringify(c).includes('access-1'));assert.ok(!JSON.stringify(c).includes('refresh-1'));
  assert.ok(!store.db.prepare('SELECT credentials FROM connections').get().credentials.includes('access-1'));
  assert.equal(JSON.parse(requests[0].options.body).expiring,1);
  await assert.rejects(connections.complete('shopify',params,browser),/already used/);
});
test('wrong browser cannot consume state; modified Shopify signatures cannot connect',async t=>{
  const {connections,time}=fixture(t);const {state}=begin(connections);const params=shopParams(state,time());
  await assert.rejects(connections.complete('shopify',params,'b'.repeat(64)),/browser/);
  params.set('hmac','0'.repeat(64));await assert.rejects(connections.complete('shopify',params,browser),/signature/);
  assert.equal(connections.list().find(c=>c.id==='shopify').authorized,false);
});
test('expired state and mismatched Shopify stores are rejected',async t=>{
  const f=fixture(t);let {state}=begin(f.connections);f.advance(601000);
  await assert.rejects(f.connections.complete('shopify',shopParams(state,f.time()),browser),/expired/);
  ({state}=begin(f.connections));await assert.rejects(f.connections.complete('shopify',shopParams(state,f.time(),{shop:'other.myshopify.com'}),browser),/does not match/);
});
test('duplicate OAuth parameters are rejected before forwarding',t=>{
  const {connections,time}=fixture(t);const {state}=begin(connections),params=shopParams(state,time());params.append('shop','other.myshopify.com');
  assert.throws(()=>connections.relay('shopify',params),/Duplicate|Invalid Shopify/);
});
test('eBay code exchange uses RuName; API check uses the sandbox endpoint',async t=>{
  const {connections,requests}=fixture(t);const {state}=begin(connections,'ebay');
  await connections.complete('ebay',new URLSearchParams({code:'test-code',state}),browser);
  assert.equal(new URLSearchParams(requests[0].options.body).get('redirect_uri'),'test-runame');
  assert.ok(requests[0].url.startsWith('https://api.sandbox.ebay.com/'));assert.ok(requests[1].url.endsWith('/sell/account/v1/privilege'));
  assert.equal(connections.list().find(c=>c.id==='ebay').connected,true);
});
test('refresh tokens rotate atomically and simultaneous checks do not race',async t=>{
  const f=fixture(t);const {state}=begin(f.connections);await f.connections.complete('shopify',shopParams(state,f.time()),browser);
  f.advance(3600000);await Promise.all([f.connections.check('shopify'),f.connections.check('shopify')]);
  const tokenRequests=f.requests.filter(r=>r.url.includes('/access_token'));assert.equal(tokenRequests.length,2);
  assert.equal(JSON.parse(tokenRequests[1].options.body).refresh_token,'refresh-1');
  f.advance(3600000);await f.connections.check('shopify');
  const latest=f.requests.filter(r=>r.url.includes('/access_token')).at(-1);assert.equal(JSON.parse(latest.options.body).refresh_token,'refresh-2');
});
test('Amazon self-authorization exchanges the token and performs a read-only check',async t=>{
  const {connections,requests}=fixture(t,{override:{AMAZON_APPLICATION_ID:'',OAUTH_CALLBACK_ORIGIN:''}});
  await connections.privateConnect('amazon',{refreshToken:'private-refresh',sellerId:'SELLER1'});
  assert.equal(new URLSearchParams(requests[0].options.body).get('refresh_token'),'private-refresh');
  assert.equal(connections.list().find(c=>c.id==='amazon').connected,true);
  assert.ok(requests[1].url.endsWith('/sellers/v1/marketplaceParticipations'));
});
test('Amazon browser flow accepts SP-API code and uses the registered redirect URI',async t=>{
  const {connections,requests}=fixture(t);const {state}=begin(connections,'amazon');
  await connections.complete('amazon',new URLSearchParams({state,spapi_oauth_code:'amazon-code',selling_partner_id:'SELLER'}),browser);
  const body=new URLSearchParams(requests[0].options.body);assert.equal(body.get('code'),'amazon-code');assert.equal(body.get('redirect_uri'),'https://callback.example/oauth/amazon/return');
});
test('Amazon continuation only allows the registered app and browser-started session',t=>{
  const {connections}=fixture(t);begin(connections,'amazon');
  const params=new URLSearchParams({amazon_callback_uri:'https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.test',amazon_state:'amazon-nonce'});
  assert.throws(()=>connections.continueAmazon(params,'b'.repeat(64)),/Start Amazon/);
  const url=new URL(connections.continueAmazon(params,browser));assert.equal(url.searchParams.get('amazon_state'),'amazon-nonce');assert.ok(url.searchParams.get('state'));
  params.set('amazon_callback_uri','https://attacker.example/apps/authorize/confirm/amzn1.sellerapps.app.test');assert.throws(()=>connections.continueAmazon(params,browser),/Unrecognized/);
});
test('Shopify own-org connection reacquires client-credential tokens on expiry',async t=>{
  const f=fixture(t);await f.connections.privateConnect('shopify',{shop:'example.myshopify.com'});f.advance(3600000);await f.connections.check('shopify');
  const requests=f.requests.filter(r=>r.url.includes('/access_token'));assert.equal(requests.length,2);
  assert.ok(requests.every(r=>JSON.parse(r.options.body).grant_type==='client_credentials'));
});
test('valid authorization with insufficient API access is not labelled verified',async t=>{
  const {connections}=fixture(t,{fetchOverride:async url=>url.endsWith('/privilege')?Response.json({error:'sensitive upstream details must not leak'},{status:403}):null});
  const {state}=begin(connections,'ebay');await connections.complete('ebay',new URLSearchParams({code:'test',state}),browser);
  const c=connections.list().find(c=>c.id==='ebay');assert.equal(c.authorized,true);assert.equal(c.connected,false);assert.equal(c.status,'error');assert.match(c.lastError,/approved scopes/);assert.ok(!c.lastError.includes('sensitive upstream'));
});
test('invalid refresh grant requires reconnecting instead of fabricating success',async t=>{
  let rejectRefresh=false;
  const f=fixture(t,{fetchOverride:async(url,options)=>rejectRefresh&&url.includes('/access_token')?Response.json({error:'invalid_grant'},{status:401}):null});
  const {state}=begin(f.connections);await f.connections.complete('shopify',shopParams(state,f.time()),browser);rejectRefresh=true;f.advance(3600000);
  await assert.rejects(f.connections.check('shopify'),/rejected/);assert.equal(f.connections.list().find(c=>c.id==='shopify').status,'reconnect');
});
test('disconnect removes secrets and outstanding states; checks cannot revive them',async t=>{
  const {connections,store}=fixture(t);await connections.privateConnect('amazon',{refreshToken:'private-refresh',sellerId:'SELLER'});const {state}=begin(connections,'amazon');
  await connections.disconnect('amazon');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM connections').get().n,0);
  assert.throws(()=>connections.attempt('amazon',state),/already used/);await assert.rejects(connections.check('amazon'),/Connect this account first/);
});
test('HTTP callback round trip binds the local browser; public tunnel cannot serve data',async t=>{
  const calls=[];
  const transport=async(url,options)=>{calls.push(url);return url.includes('/oauth2/token')?Response.json({access_token:'http-access',refresh_token:'http-refresh',expires_in:3600}):Response.json({sellerRegistrationCompleted:true});};
  const {server}=createApp({filename:':memory:',env,fetchImpl:transport});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,state=await(await fetch(`${base}/api/state`)).json();
  const response=await fetch(`${base}/api/connections/ebay/start`,{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':state.csrf},body:'{}'});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];const result=await response.json();
  const nonce=new URL(result.result.authorizationUrl).searchParams.get('state');
  const callback=await requestWithHost(`${base}/oauth/ebay/return?state=${nonce}&code=test-code`,{Host:'callback.example','x-forwarded-for':'203.0.113.1'});
  assert.equal(callback.status,303);assert.ok(callback.headers.get('location').startsWith(base));assert.equal(calls.length,0);
  const done=await fetch(callback.headers.get('location'),{headers:{Cookie:cookie},redirect:'manual'});assert.equal(done.status,303);assert.ok(done.headers.get('location').includes('result=connected'));assert.equal(calls.length,2);
  for(const route of ['/','/api/state','/connection-setup','/app.js']) {
    const blocked=await requestWithHost(`${base}${route}`,{Host:'callback.example','x-forwarded-for':'203.0.113.1'});assert.equal(blocked.status,403);
  }
  const forged=await fetch(`${base}/api/state`,{headers:{'x-forwarded-for':'203.0.113.1'}});assert.equal(forged.status,403);
  const visible=await(await fetch(`${base}/api/state`)).text();assert.ok(!visible.includes('http-access'));assert.ok(!visible.includes('http-refresh'));
});

