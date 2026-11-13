// End-to-end authorization test with a simulated Shopify page and token/API responses.
// This never contacts Shopify and never loads the user's .env or saved database.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.USERPROFILE||process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const executable=process.env.COMMERCE_BROWSER||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const secret='test-only-shopify-secret',shop='oauth-test.myshopify.com',calls=[];
const app=createApp({filename:':memory:',env:{SHOPIFY_CLIENT_ID:'test-only-client',SHOPIFY_CLIENT_SECRET:secret,OAUTH_CALLBACK_ORIGIN:'https://callback.example',EBAY_CLIENT_ID:'test-ebay-client',EBAY_CLIENT_SECRET:'test-ebay-secret',EBAY_RUNAME:'test-runame',AMAZON_CLIENT_ID:'test-amazon-client',AMAZON_CLIENT_SECRET:'test-amazon-secret',AMAZON_APPLICATION_ID:'amzn1.sellerapps.app.test'},fetchImpl:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  if(url.endsWith('/access_token'))return Response.json({access_token:'test-only-access',refresh_token:'test-only-refresh',expires_in:3600,refresh_token_expires_in:86400});
  return Response.json({data:{shop:{id:'gid://shopify/Shop/123',name:'OAuth Browser Test',myshopifyDomain:shop,currencyCode:'USD'}}});
}});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser=await playwright.chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  const page=await browser.newPage(),errors=[];let authorizationVisited=false;
  page.on('pageerror',error=>errors.push(error.message));
  for(const [provider,pattern,host] of [['Amazon','https://sellercentral.amazon.com/apps/authorize/consent?**','sellercentral.amazon.com'],['eBay','https://auth.sandbox.ebay.com/oauth2/authorize?**','auth.sandbox.ebay.com']]) {
    let visited=false;
    await page.route(pattern,async route=>{visited=true;assert.equal(new URL(route.request().url()).hostname,host);await route.fulfill({contentType:'text/html',body:`<h1>Simulated ${provider} login</h1>`});});
    await page.goto(`${base}/#connections`);
    await page.getByRole('button',{name:`Connect ${provider}`,exact:true}).click();
    await page.getByRole('heading',{name:`Simulated ${provider} login`,exact:true}).waitFor();
    assert.ok(visited,`${provider} Connect must immediately navigate to the official authorization URL`);
  }
  assert.equal(calls.length,0,'Starting authorization must not exchange tokens or access seller data');
  app.connections.config.callbackOrigin=base;
  await page.route(`https://${shop}/admin/oauth/authorize?**`,async route=>{
    authorizationVisited=true;const url=new URL(route.request().url());
    assert.equal(url.searchParams.get('client_id'),'test-only-client');
    assert.equal(url.searchParams.get('redirect_uri'),`${base}/oauth/shopify/return`);
    assert.equal(url.searchParams.get('scope'),'read_products,read_inventory');
    const params=new URLSearchParams({code:'test-only-code',shop,state:url.searchParams.get('state'),timestamp:String(Math.floor(Date.now()/1000))});
    const signed=[...params].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${key}=${value}`).join('&');
    params.set('hmac',createHmac('sha256',secret).update(signed).digest('hex'));
    await route.fulfill({status:302,headers:{location:`${base}/oauth/shopify/return?${params}`},body:''});
  });
  await page.goto(`${base}/#connections`);
  await page.getByRole('button',{name:'Connect Shopify',exact:true}).click();
  await page.getByLabel('Store domain',{exact:true}).fill(shop);
  // The normal seller journey needs only a store domain, not the developer option.
  assert.equal(await page.getByLabel('Connection method',{exact:true}).isVisible(),false);
  await page.getByRole('button',{name:'Continue with Shopify',exact:true}).click();
  await page.getByText('API verified',{exact:true}).waitFor();
  assert.ok(authorizationVisited,'Browser must navigate to the official Shopify authorization URL');
  assert.equal(page.url(),`${base}/#connections`,'Code and state must be removed from the final address');
  assert.equal(calls.length,2,'One token exchange followed by one read-only API query');
  assert.equal(calls[0].body.code,'test-only-code');assert.equal(calls[0].body.expiring,1);
  const html=await page.content();for(const credential of ['test-only-code','test-only-access','test-only-refresh',secret])assert.ok(!html.includes(credential));
  const state=await page.evaluate(async()=>await(await fetch('/api/state')).json());
  assert.equal(state.channels.find(c=>c.id==='shopify').accountLabel,'OAuth Browser Test');
  assert.equal(state.products.length,0,'Authorization must not modify inventory');
  assert.deepEqual(errors,[]);
  console.log('Portal browser tests passed: one-click Amazon/eBay redirects, plus Shopify store form → official authorization URL → signed callback → verified account. Provider responses mocked; no live account accessed.');
} finally {await browser?.close();await new Promise(resolve=>app.server.close(resolve));}

