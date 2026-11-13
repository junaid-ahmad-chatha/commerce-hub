import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require=createRequire(import.meta.url);
let playwright;
try { playwright=require('playwright'); }
catch { playwright=require(path.join(process.env.USERPROFILE||process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const executable=process.env.COMMERCE_BROWSER||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const {server}=createApp({filename:':memory:',env:{}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await playwright.chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading',{name:'Your catalog starts here'}).waitFor();
  await page.getByRole('button',{name:'Load sample catalog',exact:true}).click();
  await page.getByText('STUDIO-TOTE',{exact:true}).waitFor();
  assert.equal(await page.locator('#page tbody tr').count(),6);
  await page.getByRole('button',{name:'Manage ↗',exact:true}).first().click();
  await page.getByLabel('Adjustment (+ received, − removed)').fill('5');
  await page.getByLabel('Reason',{exact:true}).fill('Browser test restock');
  await page.getByRole('button',{name:'Apply stock adjustment',exact:true}).click();
  await page.getByText('Saved to your local workspace.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Orders',exact:true}).click();
  await page.getByRole('button',{name:'Record an order',exact:true}).first().click();
  await page.getByLabel('Marketplace order reference').fill('BROWSER-001');
  await page.getByLabel('Quantity',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Reserve stock & record order'}).click();
  await page.getByText('BROWSER-001',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Mark shipped',exact:true}).click();
  await page.getByRole('button',{name:'Confirm shipped',exact:true}).click();
  await page.getByText('Shipped',{exact:true}).last().waitFor();
  await page.getByRole('link',{name:'Listings',exact:true}).click();
  await page.getByRole('button',{name:'Review draft',exact:true}).first().click();
  await page.getByLabel('Product description',{exact:true}).fill('A factual description saved during browser verification.');
  await page.getByRole('button',{name:'Save local draft',exact:true}).click();
  await page.getByRole('link',{name:/Sync activity/}).click();
  await page.getByRole('button',{name:'Simulate eBay outage',exact:true}).click();
  await page.getByText('Failed',{exact:true}).last().waitFor();
  await page.getByRole('button',{name:'Run local simulation',exact:true}).click();
  await page.getByText('Simulated',{exact:true}).last().waitFor();
  await page.getByRole('link',{name:/Inventory/}).click();
  await page.getByRole('button',{name:'Add product',exact:true}).click();
  await page.getByLabel('Product title',{exact:true}).fill('<script>unsafe</script>');
  await page.getByLabel('Master SKU',{exact:true}).fill('ESCAPE-TEST');
  await page.getByLabel('Master price (USD)').fill('12.50');
  await page.getByRole('button',{name:'Save product',exact:true}).click();
  await page.getByText('<script>unsafe</script>',{exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'Search this view'}).fill('tote');
  assert.equal(await page.locator('#page tbody tr').count(),1);
  await page.getByRole('searchbox',{name:'Search this view'}).fill('');
  mkdirSync(path.join(root,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-results','inventory-desktop.png'),fullPage:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/#connections`);
  await page.getByRole('heading',{name:'Connections',exact:true}).waitFor();
  await page.getByRole('button',{name:'Connect Shopify',exact:true}).click();
  await page.getByLabel('Store domain',{exact:true}).fill('example.myshopify.com');
  await page.getByRole('button',{name:'Continue with Shopify',exact:true}).click();
  await page.locator('.form-error').filter({hasText:'awaiting setup by the platform owner'}).waitFor();
  assert.equal(await page.getByLabel('Store domain',{exact:true}).inputValue(),'example.myshopify.com','Failed setup must preserve form input');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Connect Amazon',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Amazon sign-in is not configured by the platform owner yet'}).waitFor();
  const amazonEntry=page.locator('.connection-entry').filter({has:page.getByRole('heading',{name:'Amazon',exact:true})});
  assert.equal(await amazonEntry.locator('.callback-details').evaluate(el=>el.open),true,'Missing configuration must reveal setup beside the clicked button');
  await amazonEntry.locator('[data-connection-error]').waitFor({state:'visible'});
  await amazonEntry.getByRole('button',{name:'Amazon developer connection options',exact:true}).click();
  await page.getByLabel('Connection method',{exact:true}).selectOption('private');
  await page.getByLabel('Self-authorized refresh token',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Self-authorized refresh token',{exact:true}).getAttribute('type'),'password');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  for(const view of ['orders','listings','sync','performance','connections']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/#${view}`);
    await page.getByRole('heading',{name:labels(view),exact:true}).waitFor();
    await page.screenshot({path:path.join(root,'test-results',`${view}-desktop.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  for(const view of ['inventory','orders','listings','sync','performance','connections']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/#${view}`);
    await page.getByRole('heading',{name:labels(view),exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${view} should not overflow the mobile viewport`);
    await page.screenshot({path:path.join(root,'test-results',`${view}-mobile.png`),fullPage:true});
  }
  const fakeRequests=[];
  const connectedApp=createApp({filename:':memory:',env:{SHOPIFY_CLIENT_ID:'ui-client',SHOPIFY_CLIENT_SECRET:'ui-secret'},fetchImpl:async(url,options)=>{
    fakeRequests.push(url);
    if(url.endsWith('/access_token'))return Response.json({access_token:'ui-access-token',expires_in:3600});
    return Response.json({data:{shop:{id:'gid://shopify/Shop/1',name:'UI Test Store',myshopifyDomain:'ui-test.myshopify.com',currencyCode:'USD'}}});
  }});
  await new Promise(resolve=>connectedApp.server.listen(0,'127.0.0.1',resolve));
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`http://127.0.0.1:${connectedApp.server.address().port}/#connections`);
    const shopifyEntry=page.locator('.connection-entry').filter({has:page.getByRole('heading',{name:'Shopify',exact:true})});
    await shopifyEntry.getByText('Platform owner setup',{exact:true}).click();
    await shopifyEntry.getByRole('button',{name:'Shopify developer connection options',exact:true}).click();
    await page.getByLabel('Store domain',{exact:true}).fill('ui-test.myshopify.com');
    await page.getByLabel('Connection method',{exact:true}).selectOption('private');
    await page.getByRole('button',{name:'Continue with Shopify',exact:true}).click();
    await page.getByText('API verified',{exact:true}).waitFor();
    assert.ok((await page.content()).includes('UI Test Store'));
    assert.ok(!(await page.content()).includes('ui-access-token'));
    await page.getByRole('button',{name:'Check connection',exact:true}).click();
    await page.getByText('Shopify read-only API check passed.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Disconnect locally',exact:true}).click();
    await page.getByRole('button',{name:'Remove local connection',exact:true}).click();
    await page.getByRole('button',{name:'Connect Shopify',exact:true}).waitFor();
    assert.equal(fakeRequests.length,3,'One token exchange and two read-only shop checks');
  } finally {await new Promise(resolve=>connectedApp.server.close(resolve));}
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: inventory/order workflows, setup errors, masked token input, mocked Shopify connect/check/disconnect, and all six desktop/mobile views.');
} finally {
  await browser?.close(); await new Promise(resolve=>server.close(resolve));
}
function labels(view) {return {inventory:'Inventory',orders:'Orders',listings:'Listings',sync:'Sync activity',performance:'Performance',connections:'Connections'}[view];}

