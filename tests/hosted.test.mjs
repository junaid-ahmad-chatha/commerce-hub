import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { createHostedApp, hostedSettings, postgresOptions } from '../lib/hosted.mjs';
import { createApp } from '../server.mjs';
import {fakePool} from './helpers/hosted-pool.mjs';

const env={NODE_ENV:'production',COMMERCE_DEPLOYMENT:'owner-preview',APP_ORIGIN:'https://preview.example',DATABASE_URL:'postgres://localhost/preview',OWNER_USER:'owner',OWNER_PASSWORD:'test-owner-password-long-enough',SESSION_SECRET:'test-session-secret-long-enough-12345',COMMERCE_TOKEN_KEY:Buffer.alloc(32,7).toString('base64'),SHOPIFY_CLIENT_ID:'test-client',SHOPIFY_CLIENT_SECRET:'test-secret'};
function poolFixture(shared) {
  const pool=fakePool(shared);
  const connect=pool.connect.bind(pool);
  pool.connect=async()=>{const client=await connect(),query=client.query.bind(client);client.query=async(sql,args)=>{
    if(sql==='COMMIT'&&pool.failCommit){pool.failCommit=false;throw new Error('test commit failure');}
    return query(sql,args);
  };return client;};
  return pool;
}
async function fixture(t,pool=poolFixture(),fetchImpl=async()=>{throw new Error('Unexpected external request');},clock=Date.now) {
  const app=await createHostedApp({env,createApp,pool,fetchImpl,clock});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const rawCall=(route,{method='GET',data,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port:app.server.address().port,path:route,method,headers:{Host:'preview.example','X-Forwarded-Proto':'https',...(data?{'Content-Type':'application/json',Origin:env.APP_ORIGIN}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);req.end(data?(typeof data==='string'?data:JSON.stringify(data)):undefined);
  });
  let sessionCookie;
  const login=async(password=env.OWNER_PASSWORD,extra={})=>{
    const page=await rawCall('/login'),html=await page.text(),challenge=/name="challenge" value="([^"]+)"/.exec(html)[1];
    return rawCall('/login',{method:'POST',data:new URLSearchParams({username:env.OWNER_USER,password,challenge,next:'/'}).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:page.headers.get('set-cookie').split(';')[0],...extra}});
  };
  const call=async(route,{auth=true,headers={},...options}={})=>{
    if(auth&&!sessionCookie){const response=await login();assert.equal(response.status,303);sessionCookie=response.headers.getSetCookie().find(c=>c.startsWith('__Host-commerce_session=')).split(';')[0];}
    return rawCall(route,{...options,headers:{...headers,...(auth?{Cookie:[sessionCookie,headers.Cookie].filter(Boolean).join('; ')}:{})}});
  };
  return {app,call,rawCall,login,pool};
}

test('hosted mode requires stable secrets, an HTTPS origin and persistent storage',()=>{
  assert.equal(hostedSettings(env).host,'preview.example');
  for(const override of [{SESSION_SECRET:''},{COMMERCE_TOKEN_KEY:''},{OWNER_PASSWORD:'short'},{DATABASE_URL:''},{APP_ORIGIN:'http://preview.example'},{OAUTH_CALLBACK_ORIGIN:'https://other.example'}])assert.throws(()=>hostedSettings({...env,...override}));
  const options=postgresOptions({...env,DATABASE_URL:'postgres://database.example/preview?sslmode=no-verify'});
  assert.equal(options.ssl.rejectUnauthorized,true);assert.ok(!options.connectionString.includes('sslmode'));
  assert.throws(()=>postgresOptions({...env,DATABASE_URL:'postgres://database.example/preview',PGSSL:'disable'}));
});

test('hosted dashboard requires owner login, correct host and HTTPS; health is public',async t=>{
  const {call}=await fixture(t);
  assert.equal((await call('/',{auth:false})).status,303);
  assert.equal((await call('/api/state',{auth:false,headers:{Authorization:'Basic invalid'}})).status,401);
  assert.equal((await call('/api/state',{headers:{Host:'other.example'}})).status,403);
  assert.equal((await call('/api/state',{headers:{'X-Forwarded-Proto':'http'}})).status,400);
  const health=await call('/api/health',{auth:false});assert.equal(health.status,200);assert.equal((await health.json()).storage,'postgres-snapshot');
  const state=await (await call('/api/state')).json();assert.equal(state.mode,'owner-preview');
  assert.equal((await call('/api/demo',{method:'POST',data:{},headers:{'x-csrf-token':state.csrf,Origin:'https://other.example'}})).status,403);
  const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
  assert.equal((await call('/',{headers:navigation})).status,200,'OAuth redirect may land on the dashboard');
  assert.equal((await call('/',{headers:navigation,auth:false})).status,303,'Landing page still requires owner login');
  assert.equal((await call('/api/state',{headers:navigation})).status,403,'Cross-site navigation cannot access workspace JSON');
  assert.equal((await call('/',{headers:{...navigation,'sec-fetch-dest':'iframe'}})).status,403,'Cross-site framing is blocked');
  assert.equal((await call('/api/demo',{method:'POST',data:{},headers:{...navigation,'x-csrf-token':state.csrf}})).status,403,'Even a valid CSRF token cannot bypass the cross-site mutation guard');
});

test('workspace survives app recreation and failed commits never report success',async t=>{
  const shared={payload:Buffer.alloc(0)},first=await fixture(t,poolFixture(shared));
  const state=await (await first.call('/api/state')).json();
  first.pool.failCommit=true;
  assert.equal((await first.call('/api/demo',{method:'POST',data:{},headers:{'x-csrf-token':state.csrf}})).status,503);
  assert.equal((await (await first.call('/api/state')).json()).products.length,0);
  assert.equal((await first.call('/api/demo',{method:'POST',data:{},headers:{'x-csrf-token':state.csrf}})).status,200);
  const second=await fixture(t,poolFixture(shared));
  const restored=await (await second.call('/api/state')).json();assert.equal(restored.products.length,6);assert.equal(restored.csrf,state.csrf);
});

test('hosted Shopify OAuth persists browser state and encrypted tokens across requests',async t=>{
  const fetchImpl=async url=>url.includes('/access_token')?Response.json({access_token:'private-test-token',refresh_token:'private-test-refresh',expires_in:3600,refresh_token_expires_in:86400,scope:'read_products,read_inventory'}):Response.json({data:{shop:{id:'gid://shopify/Shop/1',name:'Test Shop',myshopifyDomain:'example.myshopify.com',currencyCode:'USD'}}});
  const {call,pool}=await fixture(t,poolFixture(),fetchImpl),state=await (await call('/api/state')).json();
  const start=await call('/api/connections/shopify/start',{method:'POST',data:{shop:'example.myshopify.com'},headers:{'x-csrf-token':state.csrf}});
  const cookie=start.headers.get('set-cookie');assert.match(cookie,/Secure/);
  const authorization=new URL((await start.json()).result.authorizationUrl);
  assert.equal(authorization.searchParams.get('redirect_uri'),'https://preview.example/oauth/shopify/return');
  const params=new URLSearchParams({code:'test-code',shop:'example.myshopify.com',state:authorization.searchParams.get('state'),timestamp:String(Math.floor(Date.now()/1000))});
  params.set('hmac',createHmac('sha256',env.SHOPIFY_CLIENT_SECRET).update([...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('&')).digest('hex'));
  const relay=await call(`/oauth/shopify/return?${params}`,{auth:false});assert.equal(relay.status,303);
  const complete=new URL(relay.headers.get('location'));assert.equal(complete.origin,env.APP_ORIGIN);
  const done=await call(complete.pathname+complete.search,{headers:{Cookie:cookie.split(';')[0]}});assert.equal(done.status,303);
  assert.match(done.headers.get('location'),/result=connected/);
  const connected=await (await call('/api/state')).json();assert.equal(connected.channels.find(c=>c.id==='shopify').connected,true);
  assert.ok(!JSON.stringify(connected).includes('private-test-token'));assert.ok(!pool.shared.payload.includes(Buffer.from('private-test-token')));
});

test('login rejects cross-site and forged forms, preserves only username, and throttles failures',async t=>{
  let now=Date.now();const {rawCall,login}=await fixture(t,undefined,undefined,()=>now);
  const page=await rawCall('/login');assert.equal(page.status,200);assert.equal(page.headers.has('www-authenticate'),false);assert.match(page.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  const form={method:'POST',data:'username=owner&password=wrong&challenge=forged',headers:{'Content-Type':'application/x-www-form-urlencoded'}};
  assert.equal((await rawCall('/login',form)).status,403);
  assert.equal((await login(env.OWNER_PASSWORD,{Origin:'https://attacker.example'})).status,403);
  const wrong=await login('private-wrong-password');assert.equal(wrong.status,401);const html=await wrong.text();assert.match(html,/value="owner"/);assert.ok(!html.includes('private-wrong-password'));
  for(let i=0;i<4;i++){now+=60000;assert.equal((await login('incorrect')).status,401);}
  const blocked=await login();assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
});

test('sessions survive app recreation, reject tampering, expire, and are revoked on sign-out',async t=>{
  let now=Date.now();const shared={payload:Buffer.alloc(0)},first=await fixture(t,poolFixture(shared),undefined,()=>now);
  const signedIn=await first.login();assert.equal(signedIn.status,303);assert.equal(signedIn.headers.get('location'),'/');
  const session=signedIn.headers.getSetCookie().find(c=>c.startsWith('__Host-commerce_session=')).split(';')[0];assert.match(signedIn.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Lax/);
  const headers={Cookie:session};assert.equal((await first.rawCall('/api/state',{headers})).status,200);
  assert.equal((await first.rawCall('/api/state',{headers:{Cookie:session+'tampered'}})).status,401);
  const second=await fixture(t,poolFixture(shared),undefined,()=>now);
  assert.equal((await second.rawCall('/api/state',{headers})).status,200);
  assert.equal((await second.rawCall('/logout',{method:'POST',headers:{...headers,Origin:'https://attacker.example'}})).status,403);
  assert.equal((await second.rawCall('/logout',{method:'POST',headers:{...headers,Origin:env.APP_ORIGIN}})).status,303);
  assert.equal((await first.rawCall('/api/state',{headers})).status,401,'Replaying a logged-out cookie is rejected');
  const newLogin=await first.login(),newSession=newLogin.headers.getSetCookie().find(c=>c.startsWith('__Host-commerce_session=')).split(';')[0];
  now+=8*3600000+1;assert.equal((await first.rawCall('/api/state',{headers:{Cookie:newSession}})).status,401);
});

test('a login form is single-use over HTTP and security activity requires the owner session',async t=>{
  const {rawCall}=await fixture(t);
  assert.equal((await rawCall('/api/security')).status,401);
  const page=await rawCall('/login'),html=await page.text(),challenge=/name="challenge" value="([^"]+)"/.exec(html)[1];
  const form={method:'POST',data:new URLSearchParams({username:env.OWNER_USER,password:env.OWNER_PASSWORD,challenge,next:'https://attacker.example'}).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:page.headers.get('set-cookie').split(';')[0]}};
  const result=await rawCall('/login',form);assert.equal(result.status,303);assert.equal(result.headers.get('location'),'/');
  assert.equal((await rawCall('/login',form)).status,403);
  const session=result.headers.getSetCookie().find(c=>c.startsWith('__Host-commerce_session=')).split(';')[0];
  const events=await rawCall('/api/security',{headers:{Cookie:session}});assert.equal(events.status,200);
  const body=await events.text();assert.ok(body.includes('session.created'));assert.ok(!body.includes(env.OWNER_PASSWORD));assert.ok(!body.includes(challenge));assert.ok(!body.includes(session));
  assert.equal((await rawCall('/api/security',{headers:{Cookie:session,'sec-fetch-site':'cross-site'}})).status,403);
});

