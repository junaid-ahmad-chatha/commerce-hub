import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DomainError, CHANNELS } from './store.mjs';

export const SHOP_QUERY = 'query ConnectionShop { shop { id name myshopifyDomain currencyCode } }';
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();
const validProvider = name => { if (!CHANNELS.includes(name)) throw new DomainError('Unknown marketplace.',404); return name; };
const required = (value,label,max=4096) => {
  if(typeof value!=='string'||!value.trim()||value.length>max) throw new DomainError(`${label} is required.`);
  return value.trim();
};
export function normalizeShop(value) {
  const shop=String(value||'').trim().toLowerCase().replace(/^https:\/\//,'').replace(/\/$/,'');
  if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)||shop.length>253) throw new DomainError('Enter the store’s exact name.myshopify.com domain, without a path.');
  return shop;
}
function origin(value,label) {
  let url;try{url=new URL(value);}catch{throw new DomainError(`${label} must be a valid origin.`);}
  const loopback=['localhost','127.0.0.1'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&loopback)) throw new DomainError(`${label} must be HTTPS or loopback HTTP, without a path.`);
  return url.origin;
}
export function readConnectionConfig(env=process.env) {
  const hosted=env.NODE_ENV==='production'&&env.COMMERCE_DEPLOYMENT==='owner-preview';
  const localOrigin=origin(hosted?env.APP_ORIGIN:env.LOCAL_APP_ORIGIN||`http://localhost:${env.PORT||3100}`,hosted?'APP_ORIGIN':'LOCAL_APP_ORIGIN');
  if(hosted?new URL(localOrigin).protocol!=='https:':!['localhost','127.0.0.1'].includes(new URL(localOrigin).hostname)||!localOrigin.startsWith('http:')) throw new DomainError(hosted?'APP_ORIGIN must use HTTPS.':'LOCAL_APP_ORIGIN must be loopback HTTP for this local app.');
  const callbackOrigin=origin(env.OAUTH_CALLBACK_ORIGIN||localOrigin,'OAUTH_CALLBACK_ORIGIN');
  const ebayEnvironment=env.EBAY_ENVIRONMENT||'sandbox';
  if(!['sandbox','production'].includes(ebayEnvironment)) throw new DomainError('EBAY_ENVIRONMENT must be sandbox or production.');
  const region=env.AMAZON_REGION||'na';
  if(!['na','eu','fe'].includes(region)) throw new DomainError('AMAZON_REGION must be na, eu, or fe.');
  const market=env.AMAZON_MARKETPLACE||({na:'US',eu:'UK',fe:'JP'}[region]);
  const markets={US:['na','sellercentral.amazon.com'],CA:['na','sellercentral.amazon.ca'],MX:['na','sellercentral.amazon.com.mx'],BR:['na','sellercentral.amazon.com.br'],UK:['eu','sellercentral.amazon.co.uk'],DE:['eu','sellercentral.amazon.de'],FR:['eu','sellercentral.amazon.fr'],IT:['eu','sellercentral.amazon.it'],ES:['eu','sellercentral.amazon.es'],NL:['eu','sellercentral.amazon.nl'],SE:['eu','sellercentral.amazon.se'],PL:['eu','sellercentral.amazon.pl'],BE:['eu','sellercentral.amazon.com.be'],TR:['eu','sellercentral.amazon.com.tr'],AE:['eu','sellercentral.amazon.ae'],SA:['eu','sellercentral.amazon.sa'],IN:['eu','sellercentral.amazon.in'],JP:['fe','sellercentral.amazon.co.jp'],AU:['fe','sellercentral.amazon.com.au'],SG:['fe','sellercentral.amazon.sg']};
  if(!markets[market]||markets[market][0]!==region) throw new DomainError('AMAZON_MARKETPLACE must match AMAZON_REGION. See the local connection guide.');
  const version=env.SHOPIFY_API_VERSION||'2026-10';
  if(!/^20\d\d-(01|04|07|10)$/.test(version)) throw new DomainError('SHOPIFY_API_VERSION must be a stable YYYY-MM version.');
  return {localOrigin,callbackOrigin,hosted,
    shopify:{clientId:env.SHOPIFY_CLIENT_ID||'',clientSecret:env.SHOPIFY_CLIENT_SECRET||'',scopes:env.SHOPIFY_SCOPES||'read_products,read_inventory',version},
    ebay:{clientId:env.EBAY_CLIENT_ID||'',clientSecret:env.EBAY_CLIENT_SECRET||'',ruName:env.EBAY_RUNAME||'',environment:ebayEnvironment,scopes:env.EBAY_SCOPES||'https://api.ebay.com/oauth/api_scope/sell.account.readonly'},
    amazon:{clientId:env.AMAZON_CLIENT_ID||'',clientSecret:env.AMAZON_CLIENT_SECRET||'',applicationId:env.AMAZON_APPLICATION_ID||'',region,marketplace:market,sellerHost:markets[market][1],draft:env.AMAZON_DRAFT!=='false'}
  };
}
export function loadTokenKey(directory,encoded) {
  if(encoded) {const key=Buffer.from(encoded,'base64');if(key.length!==32)throw new DomainError('COMMERCE_TOKEN_KEY must be 32 random bytes encoded in base64.');return key;}
  if(!directory)return randomBytes(32);
  mkdirSync(directory,{recursive:true});const filename=path.join(directory,'connection-key');
  try {const key=readFileSync(filename);if(key.length!==32)throw new DomainError('Invalid connection-key file. Restore the original key to access saved connections.');return key;}
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    const key=randomBytes(32);try{writeFileSync(filename,key,{flag:'wx',mode:0o600});return key;}
    catch(error){if(error.code==='EEXIST')return readFileSync(filename);throw error;}
  }
}
export function encryptTokens(key,provider,data) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(provider));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64');
}
export function decryptTokens(key,provider,value) {
  try {const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from(provider));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));}
  catch {throw new DomainError('Saved credentials cannot be decrypted. Restore the original connection key, or disconnect and reconnect.',409);}
}
export function verifyShopifyHmac(params,secret,clock=Date.now()) {
  for(const key of new Set(params.keys()))if(params.getAll(key).length!==1)throw new DomainError('Duplicate authorization parameters.',403);
  const supplied=params.get('hmac')||'';
  if(!/^[a-f0-9]{64}$/i.test(supplied))throw new DomainError('Invalid Shopify callback signature.',403);
  const timestamp=Number(params.get('timestamp'));
  if(!Number.isFinite(timestamp)||Math.abs(clock/1000-timestamp)>600)throw new DomainError('Shopify callback expired. Start again.',403);
  const message=[...params].filter(([key])=>key!=='hmac').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${key}=${value}`).join('&');
  const expected=createHmac('sha256',secret).update(message).digest();
  if(!timingSafeEqual(expected,Buffer.from(supplied,'hex')))throw new DomainError('Invalid Shopify callback signature.',403);
}

export function createConnections({db,directory=null,env=process.env,fetchImpl=globalThis.fetch,key=loadTokenKey(directory,env.COMMERCE_TOKEN_KEY),clock=Date.now}) {
  const config=readConnectionConfig(env),locks=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS connections (
    provider TEXT PRIMARY KEY, credentials TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL, account_label TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checked_at TEXT, last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS oauth_attempts (
    state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, browser_hash TEXT NOT NULL,
    context TEXT NOT NULL, expires_at INTEGER NOT NULL
  );`);
  const get=name=>db.prepare('SELECT * FROM connections WHERE provider=?').get(validProvider(name));
  const fingerprint=name=>digest(JSON.stringify(config[name]));
  const callback=name=>`${config.callbackOrigin}/oauth/${name}/return`;
  const expiry=seconds=>Number(seconds)>0?clock()+Number(seconds)*1000:null;
  async function locked(name,fn) {
    const previous=locks.get(name)||Promise.resolve();let done;const current=new Promise(resolve=>done=resolve);locks.set(name,current);
    await previous;try{return await fn();}finally{done();if(locks.get(name)===current)locks.delete(name);}
  }
  function settings(name,oauth=true) {
    const c=config[validProvider(name)],missing=[];
    const prefix=name.toUpperCase();if(!c.clientId)missing.push(`${prefix}_CLIENT_ID`);if(!c.clientSecret)missing.push(`${prefix}_CLIENT_SECRET`);
    if(name==='ebay'&&oauth&&!c.ruName)missing.push('EBAY_RUNAME');
    if(name==='amazon'&&oauth&&!c.applicationId)missing.push('AMAZON_APPLICATION_ID');
    if(name!=='shopify'&&oauth&&!config.callbackOrigin.startsWith('https:'))missing.push('OAUTH_CALLBACK_ORIGIN (HTTPS)');
    if(missing.length)throw new DomainError(`Configure ${missing.join(', ')} in commerce-hub/.env and restart the server.`,409);
    return c;
  }
  function list() {
    return CHANNELS.map(name=>{
      const row=get(name);let missing=[];try{settings(name);}catch(error){missing=error.message.match(/Configure (.+) in/)?.[1]?.split(', ')||[];}
      const changed=row&&row.config_fingerprint!==fingerprint(name);
      return {id:name,configured:missing.length===0,missing,connected:!!row&&row.status==='connected'&&!changed,authorized:!!row,
        status:changed?'reconnect':row?.status||'disconnected',accountLabel:row?.account_label||null,
        metadata:row?JSON.parse(row.metadata):{},checkedAt:row?.checked_at||null,
        lastError:changed?'App configuration changed. Disconnect and reconnect this account.':row?.last_error||null,
        environment:name==='ebay'?config.ebay.environment:name==='amazon'?config.amazon.region:'store',
        callbackUrl:callback(name),loginUrl:name==='amazon'?`${config.callbackOrigin}/oauth/amazon/login`:null,
        privateConfigured:!!config[name].clientId&&!!config[name].clientSecret,mode:'read-only',inventorySync:'simulation'};
    });
  }
  function newAttempt(name,browser,context) {
    db.prepare('DELETE FROM oauth_attempts WHERE expires_at<?').run(clock());
    db.prepare('DELETE FROM oauth_attempts WHERE provider=? AND browser_hash=?').run(name,digest(browser));
    const state=randomBytes(32).toString('hex');
    db.prepare('INSERT INTO oauth_attempts VALUES(?,?,?,?,?)').run(digest(state),name,digest(browser),JSON.stringify({...context,fingerprint:fingerprint(name)}),clock()+600000);
    return state;
  }
  function attempt(name,state) {
    if(typeof state!=='string'||!/^[a-f0-9]{64}$/.test(state))throw new DomainError('Invalid authorization state. Start connecting again.',403);
    const row=db.prepare('SELECT * FROM oauth_attempts WHERE state_hash=? AND provider=?').get(digest(state),validProvider(name));
    if(!row||row.expires_at<=clock())throw new DomainError('Authorization expired or was already used. Start connecting again.',403);
    return {...row,context:JSON.parse(row.context)};
  }
  function validateBrowser(a,browser) {
    if(!browser||a.browser_hash!==digest(browser))throw new DomainError('Authorization must finish in the browser that started it. Open the configured local app URL and reconnect.',403);
    if(a.context.fingerprint!==fingerprint(a.provider))throw new DomainError('App settings changed during authorization. Start again.',409);
  }
  function start(name,input,browser,returnOrigin) {
    const c=settings(name),local=origin(returnOrigin,'Return address');
    if(config.hosted?local!==config.localOrigin:!['localhost','127.0.0.1'].includes(new URL(local).hostname))throw new DomainError('Start authorization from this application.',403);
    const shop=name==='shopify'?normalizeShop(input.shop):null;
    const state=newAttempt(name,browser,{shop,returnOrigin:local,redirectUri:callback(name)});
    let url;
    if(name==='shopify') {url=new URL(`https://${shop}/admin/oauth/authorize`);url.search=new URLSearchParams({client_id:c.clientId,scope:c.scopes,redirect_uri:callback(name),state}).toString();}
    if(name==='ebay') {url=new URL(`https://auth.${c.environment==='sandbox'?'sandbox.':''}ebay.com/oauth2/authorize`);url.search=new URLSearchParams({client_id:c.clientId,response_type:'code',redirect_uri:c.ruName,scope:c.scopes,state}).toString();}
    if(name==='amazon') {url=new URL(`https://${c.sellerHost}/apps/authorize/consent`);url.search=new URLSearchParams({application_id:c.applicationId,state,...(c.draft?{version:'beta'}:{})}).toString();}
    return {authorizationUrl:url.toString()};
  }
  async function jsonRequest(url,options,provider) {
    let response;try{response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(config.hosted?10000:20000)});}catch {throw new DomainError(`${provider} could not be reached. Check the connection and try again.`,502);}
    let data;try{data=await response.json();}catch{throw new DomainError(`${provider} returned an unreadable response. Try again.`,502);}
    if(!response.ok) {
      const error=new DomainError(response.status===429?`${provider} rate limit reached. Wait before retrying.`:response.status===401?`${provider} rejected the credentials. Reconnect the account.`:response.status===403?`${provider} denied this API call. Check the app’s approved scopes and seller permissions.`:`${provider} request failed (HTTP ${response.status}). Check app credentials, callback configuration, and authorization.`,response.status===429?429:502);
      error.upstreamStatus=response.status;throw error;
    }
    return data;
  }
  function ebayHeaders(c) {return {Authorization:`Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'};}
  function ebayBase(c) {return `https://api.${c.environment==='sandbox'?'sandbox.':''}ebay.com`;}
  async function exchange(name,context,params) {
    const c=settings(name),code=required(params.get(name==='amazon'?'spapi_oauth_code':'code'),'Authorization code',12000);
    if(name==='shopify') {
      if(normalizeShop(params.get('shop'))!==context.shop)throw new DomainError('Shopify callback store does not match the requested store.',403);
      verifyShopifyHmac(params,c.clientSecret,clock());
      return jsonRequest(`https://${context.shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:c.clientId,client_secret:c.clientSecret,code,expiring:1})},'Shopify');
    }
    const body={grant_type:'authorization_code',code,redirect_uri:name==='ebay'?c.ruName:context.redirectUri};
    if(name==='amazon')Object.assign(body,{client_id:c.clientId,client_secret:c.clientSecret});
    return jsonRequest(name==='ebay'?`${ebayBase(c)}/identity/v1/oauth2/token`:'https://api.amazon.com/auth/o2/token',{
      method:'POST',headers:name==='ebay'?ebayHeaders(c):{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()
    },name==='ebay'?'eBay':'Amazon');
  }
  function tokenRecord(data,previous={}) {
    if(typeof data.access_token!=='string'||!data.access_token||!Number(data.expires_in)||Number(data.expires_in)<=0)throw new DomainError('The marketplace did not return a valid expiring access token.',502);
    return {...previous,accessToken:data.access_token,refreshToken:data.refresh_token||previous.refreshToken||null,
      expiresAt:expiry(data.expires_in),refreshExpiresAt:data.refresh_token_expires_in?expiry(data.refresh_token_expires_in):previous.refreshExpiresAt||null,
      scopes:typeof data.scope==='string'?data.scope:previous.scopes||''};
  }
  function save(name,tokens,label,metadata={}) {
    db.prepare(`INSERT INTO connections(provider,credentials,config_fingerprint,status,account_label,metadata,created_at,updated_at) VALUES(?,?,?,'authorized',?,?,?,?)
      ON CONFLICT(provider) DO UPDATE SET credentials=excluded.credentials,config_fingerprint=excluded.config_fingerprint,status='authorized',account_label=excluded.account_label,metadata=excluded.metadata,updated_at=excluded.updated_at,checked_at=NULL,last_error=NULL`)
      .run(name,encryptTokens(key,name,tokens),fingerprint(name),label,JSON.stringify(metadata),iso(),iso());
  }
  async function complete(name,params,browser) {
    return locked(validProvider(name),async()=>{
      const a=attempt(name,params.get('state'));validateBrowser(a,browser);
      db.prepare('DELETE FROM oauth_attempts WHERE state_hash=?').run(a.state_hash);
      if(params.has('error'))throw new DomainError('Marketplace authorization was declined or interrupted. You can try connecting again.',400);
      const sellerId=name==='amazon'?required(params.get('selling_partner_id'),'Amazon seller ID',120):null;
      const data=await exchange(name,a.context,params);
      const tokens=tokenRecord(data,{shop:a.context.shop,sellerId,grant:'oauth'});
      if(!tokens.refreshToken)throw new DomainError('No refresh token was returned. Check the app access type and reconnect.',502);
      save(name,tokens,name==='shopify'?a.context.shop:name==='amazon'?`Amazon seller ${sellerId}`:`eBay seller (${config.ebay.environment})`);
      try{await checkInternal(name);}catch{/* The grant is saved; read access failures are visible for retry. */}
      return {returnOrigin:a.context.returnOrigin,status:get(name).status};
    });
  }
  function relay(name,params) {
    const a=attempt(name,params.get('state'));
    const url=new URL(`/oauth/${name}/complete`,a.context.returnOrigin);
    // Only OAuth parameters are forwarded, never arbitrary redirect targets.
    for(const param of ['state','code','spapi_oauth_code','selling_partner_id','shop','hmac','timestamp','host','signature','error','error_description']) {
      if(params.getAll(param).length>1)throw new DomainError('Duplicate authorization parameters.',403);
      if(params.has(param)){const value=params.get(param);if(value.length>16000)throw new DomainError('Invalid authorization response.',400);url.searchParams.set(param,value);}
    }
    // Shopify signs every callback query parameter, including future fields.
    if(name==='shopify') {
      for(const [param,value] of params){if(params.getAll(param).length>1||value.length>16000)throw new DomainError('Invalid Shopify authorization response.',403);url.searchParams.set(param,value);}
    }
    return url.toString();
  }
  function amazonLoginRelay(params) {
    const url=new URL('/oauth/amazon/continue',config.localOrigin);
    for(const field of ['amazon_callback_uri','amazon_state','selling_partner_id','version']) {
      if(params.getAll(field).length>1)throw new DomainError('Invalid Amazon login parameters.',403);
      if(params.has(field))url.searchParams.set(field,params.get(field).slice(0,12000));
    }
    return url.toString();
  }
  function continueAmazon(params,browser) {
    const c=settings('amazon');let url;
    try{url=new URL(params.get('amazon_callback_uri'));}catch{throw new DomainError('Invalid Amazon continuation URL.',403);}
    const allowed=new Set([c.sellerHost,({na:'amazon.com',eu:'amazon.co.uk',fe:'amazon.co.jp'}[c.region])]);
    if(url.protocol!=='https:'||!allowed.has(url.hostname)||url.port||url.username||url.password||url.pathname!==`/apps/authorize/confirm/${c.applicationId}`)throw new DomainError('Unrecognized Amazon continuation URL.',403);
    const row=db.prepare('SELECT * FROM oauth_attempts WHERE provider=? AND browser_hash=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1').get('amazon',digest(browser||''),clock());
    if(!row)throw new DomainError('Start Amazon authorization from Connections in the configured local app URL first.',403);
    const a={...row,context:JSON.parse(row.context)};validateBrowser(a,browser);
    const state=newAttempt('amazon',browser,a.context);
    url.search=new URLSearchParams({amazon_state:required(params.get('amazon_state'),'Amazon state',12000),state,redirect_uri:callback('amazon'),...(c.draft?{version:'beta'}:{})}).toString();
    return url.toString();
  }
  async function refresh(name,tokens) {
    const c=settings(name,false);
    if(tokens.refreshExpiresAt&&tokens.refreshExpiresAt<=clock())throw new DomainError('The refresh token expired. Disconnect and reconnect this account.',401);
    let data;
    if(name==='shopify') {
      const body=tokens.grant==='client_credentials'?{grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret}:{grant_type:'refresh_token',client_id:c.clientId,client_secret:c.clientSecret,refresh_token:required(tokens.refreshToken,'Refresh token')};
      data=await jsonRequest(`https://${normalizeShop(tokens.shop)}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},'Shopify');
    } else {
      const body={grant_type:'refresh_token',refresh_token:required(tokens.refreshToken,'Refresh token',16000)};
      if(name==='amazon')Object.assign(body,{client_id:c.clientId,client_secret:c.clientSecret});
      data=await jsonRequest(name==='ebay'?`${ebayBase(c)}/identity/v1/oauth2/token`:'https://api.amazon.com/auth/o2/token',{method:'POST',headers:name==='ebay'?ebayHeaders(c):{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()},name==='ebay'?'eBay':'Amazon');
    }
    const next=tokenRecord(data,tokens);
    db.prepare('UPDATE connections SET credentials=?,updated_at=? WHERE provider=?').run(encryptTokens(key,name,next),iso(),name);
    return next;
  }
  async function checkInternal(name) {
    const row=get(name);if(!row)throw new DomainError('Connect this account first.',409);
    try {
      if(row.config_fingerprint!==fingerprint(name))throw new DomainError('App configuration changed. Disconnect and reconnect.',409);
      let tokens=decryptTokens(key,name,row.credentials);
      const c=settings(name,false);
      if(!tokens.expiresAt||tokens.expiresAt<=clock()+60000)tokens=await refresh(name,tokens);
      let label=row.account_label,metadata;
      if(name==='shopify') {
        const data=await jsonRequest(`https://${normalizeShop(tokens.shop)}/admin/api/${c.version}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':tokens.accessToken},body:JSON.stringify({query:SHOP_QUERY})},'Shopify');
        if(data.errors?.length||!data.data?.shop)throw new DomainError('Shopify denied the shop query. Check app scopes and reconnect if necessary.',502);
        const shop=data.data.shop;
        if(normalizeShop(shop.myshopifyDomain)!==tokens.shop)throw new DomainError('The returned Shopify store does not match this connection.',502);
        label=String(shop.name).slice(0,200);metadata={shop:tokens.shop,shopId:shop.id,currency:shop.currencyCode,check:'Shop GraphQL query succeeded'};
      }
      if(name==='ebay') {
        const data=await jsonRequest(`${ebayBase(c)}/sell/account/v1/privilege`,{headers:{Authorization:`Bearer ${tokens.accessToken}`,Accept:'application/json'}},'eBay');
        if(typeof data.sellerRegistrationCompleted!=='boolean')throw new DomainError('eBay returned an unexpected account response.',502);
        metadata={sellerRegistrationCompleted:data.sellerRegistrationCompleted,environment:c.environment,check:'Seller privileges API succeeded'};
      }
      if(name==='amazon') {
        const data=await jsonRequest(`https://sellingpartnerapi-${c.region}.amazon.com/sellers/v1/marketplaceParticipations`,{headers:{'x-amz-access-token':tokens.accessToken,Accept:'application/json'}},'Amazon');
        if(!Array.isArray(data.payload)||data.errors?.length)throw new DomainError('Amazon did not return marketplace access. Check approved SP-API roles.',502);
        metadata={sellerId:tokens.sellerId,region:c.region,marketplaces:data.payload.map(p=>({id:p.marketplace?.id,name:p.marketplace?.name,participating:p.participation?.isParticipating})),check:'Marketplace participations API succeeded'};
      }
      db.prepare("UPDATE connections SET status='connected',account_label=?,metadata=?,checked_at=?,updated_at=?,last_error=NULL WHERE provider=?").run(label,JSON.stringify(metadata),iso(),iso(),name);
      return {verified:true};
    } catch(error) {
      const message=error instanceof DomainError?error.message:'Connection check failed. Try reconnecting the account.';
      const status=[400,401].includes(error.upstreamStatus)||error.status===401?'reconnect':'error';
      db.prepare('UPDATE connections SET status=?,last_error=?,updated_at=? WHERE provider=?').run(status,message,iso(),name);
      throw error instanceof DomainError?error:new DomainError(message,502);
    }
  }
  async function privateConnect(name,input) {
    if(!['amazon','shopify'].includes(name))throw new DomainError('Use the eBay authorization flow.');
    return locked(name,async()=>{
      settings(name,false);let tokens,label;
      if(name==='amazon') {
        const refreshToken=required(input.refreshToken,'Self-authorized Amazon refresh token',16000),sellerId=required(input.sellerId,'Amazon seller ID',120);
        const c=config.amazon,data=await jsonRequest('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:c.clientId,client_secret:c.clientSecret}).toString()},'Amazon');
        tokens=tokenRecord(data,{refreshToken,sellerId,grant:'self_authorized'});label=`Amazon seller ${sellerId}`;
      } else {
        const shop=normalizeShop(input.shop),c=config.shopify;
        const data=await jsonRequest(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret})},'Shopify');
        tokens=tokenRecord(data,{shop,grant:'client_credentials'});label=shop;
      }
      save(name,tokens,label);try{await checkInternal(name);}catch{/* Keep authorized credentials for a repeatable permission check. */}
      return {verified:get(name).status==='connected'};
    });
  }
  async function disconnect(name) {
    return locked(validProvider(name),async()=>{
      db.prepare('DELETE FROM connections WHERE provider=?').run(name);
      db.prepare('DELETE FROM oauth_attempts WHERE provider=?').run(name);
      return {removed:true,revokedAtProvider:false};
    });
  }
  return {config,list,start,attempt,relay,complete,amazonLoginRelay,continueAmazon,privateConnect,disconnect,check:name=>locked(validProvider(name),()=>checkInternal(name))};
}

