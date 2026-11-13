import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSecurity} from './security.mjs';

export const authenticatedOwner=Symbol('authenticatedOwner');
const sessionName='__Host-commerce_session',challengeName='__Host-commerce_login';
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookie=(req,name)=>String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
const setCookie=(name,value,age,sameSite='Lax')=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${age}`;
const safeNext=value=>typeof value==='string'&&value.length<16000&&(value==='/'||/^\/oauth\/(amazon|ebay|shopify)\/(complete|continue)\?[^\r\n]*$/.test(value))?value:'/';

export async function createOwnerAuth({pool,env,origin,clock=Date.now}) {
  await pool.query('CREATE TABLE IF NOT EXISTS commerce_hub_sessions (token_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL)');
  const protection=await createSecurity({pool,env,clock});
  const mac=value=>createHmac('sha256',env.SESSION_SECRET).update(value).digest('base64url');
  const sign=value=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return `${body}.${mac(body)}`;};
  const unpack=value=>{try{const [body,signature,...extra]=String(value||'').split('.');if(extra.length||!equal(signature,mac(body)))return null;return JSON.parse(Buffer.from(body,'base64url'));}catch{return null;}};
  const fingerprint=()=>mac(`owner:${env.OWNER_USER}:${env.OWNER_PASSWORD}`);
  // no-referrer makes native form navigations send Origin: null in Chromium.
  // Send only the origin (never an OAuth continuation query) while retaining checks.
  const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin','Strict-Transport-Security':'max-age=31536000','Content-Security-Policy':"default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
  const redirect=(res,to,cookies)=>{res.writeHead(303,{...security,Location:to,...(cookies?{'Set-Cookie':cookies}:{})});res.end();};
  const json=(res,status,error)=>{res.writeHead(status,{...security,'Content-Type':'application/json'});res.end(JSON.stringify({error}));};
  async function page(res,{status=200,error='',username='',next='/',expired=false,retryAfter=0}={}) {
    const expires=clock()+600000,challenge=sign({nonce:randomBytes(24).toString('hex'),expires});
    await protection.issueChallenge(challenge,expires);
    res.writeHead(status,{...security,'Content-Type':'text/html; charset=utf-8','Set-Cookie':setCookie(challengeName,challenge,600,'Strict'),...(retryAfter?{'Retry-After':String(retryAfter)}:{})});
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Commerce Hub</title><link rel="stylesheet" href="/login.css"><script src="/login.js" defer></script></head><body><main class="login-layout"><section class="welcome" aria-label="Commerce Hub"><a class="brand" href="/login"><span class="brand-mark" aria-hidden="true">ch</span>Commerce Hub</a><div class="welcome-copy"><p class="eyebrow">YOUR SELLER WORKSPACE</p><h1>A clear view.<br>A calmer workday.</h1><p>Bring your inventory records, listing drafts, and marketplace connections into one workspace.</p><div class="channels"><span>Amazon</span><span>eBay</span><span>Shopify</span></div></div><p class="welcome-foot">Private workspace · Access for the account owner</p></section><section class="login-panel"><div class="login-form"><p class="eyebrow">WELCOME BACK</p><h2>Sign in to your workspace</h2><p class="intro">Use your Commerce Hub account credentials.</p>${expired?'<p class="session-note" role="status">Sign in to continue. Your previous session may have expired.</p>':''}${error?`<p class="form-error" role="alert">${escape(error)}</p>`:''}<form method="post" action="/login"><input type="hidden" name="challenge" value="${challenge}"><input type="hidden" name="next" value="${escape(safeNext(next))}"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required maxlength="200" value="${escape(username)}" autofocus><label for="password">Password</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button id="toggle-password" type="button" aria-controls="password" aria-pressed="false">Show</button></div><button class="submit" type="submit">Sign in</button></form><p class="help">Need access? Use the login details provided by your workspace administrator.</p><p class="session-detail">You’ll stay signed in for up to 8 hours on this browser. Sign out when using a shared computer.</p></div><p class="panel-foot">Commerce Hub <span>Inventory, in one place.</span></p></section></main></body></html>`);
  }
  return {
    async limit(req,res){
      const retryAfter=await protection.requestLimit(req);
      if(!retryAfter)return false;
      res.writeHead(429,{...security,'Content-Type':'application/json','Retry-After':String(retryAfter)});res.end(JSON.stringify({error:'Too many requests. Please wait and try again.'}));return true;
    },
    async handle(req,res,url) {
      if(req.method==='GET'&&['/login.css','/login.js'].includes(url.pathname)) {
        const filename=url.pathname.slice(1),type=filename.endsWith('.css')?'text/css':'text/javascript';
        res.writeHead(200,{...security,'Content-Type':`${type}; charset=utf-8`});res.end(await readFile(new URL(`../public/${filename}`,import.meta.url)));return true;
      }
      if(url.pathname==='/login') {
        if(req.method==='GET'){await page(res,{next:url.searchParams.get('next'),expired:url.searchParams.has('expired')});return true;}
        if(req.method!=='POST'){json(res,405,'Use the sign-in form.');return true;}
        if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){await protection.audit('login.rejected','invalid_origin',protection.source(req));json(res,403,'Open the sign-in page and try again.');return true;}
        if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')){json(res,415,'Use the sign-in form.');return true;}
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192){json(res,413,'Sign-in request too large.');return true;}chunks.push(chunk);}
        const fields=new URLSearchParams(Buffer.concat(chunks).toString()),challenge=fields.get('challenge'),decoded=unpack(challenge);
        const next=safeNext(fields.get('next')),username=(fields.get('username')||'').slice(0,200);
        if(!decoded||decoded.expires<=clock()||!equal(challenge,cookie(req,challengeName))){await protection.audit('login.invalid','invalid_challenge',protection.source(req));await page(res,{status:403,error:'This sign-in form expired. Please try again.',username,next});return true;}
        const userMatches=equal(username,env.OWNER_USER),passwordMatches=equal(fields.get('password')||'',env.OWNER_PASSWORD);
        const result=await protection.login({req,challenge,userMatches,passwordMatches});
        if(result.outcome==='invalid'){await page(res,{status:403,error:'This sign-in form expired. Please try again.',username,next});return true;}
        if(result.outcome==='blocked'){await page(res,{status:429,error:`Too many sign-in attempts. Try again in ${result.retryAfter} seconds.`,username,next,retryAfter:result.retryAfter});return true;}
        if(result.outcome==='failed'){await page(res,{status:401,error:'The username or password is incorrect.',username,next});return true;}
        const token=randomBytes(32).toString('hex'),expires=clock()+8*3600000;
        const previous=unpack(cookie(req,sessionName));if(previous?.token)await pool.query('DELETE FROM commerce_hub_sessions WHERE token_hash=$1',[digest(previous.token)]);
        await pool.query('DELETE FROM commerce_hub_sessions WHERE expires_at <= $1',[clock()]);
        await pool.query('INSERT INTO commerce_hub_sessions(token_hash,expires_at) VALUES($1,$2)',[digest(token),expires]);
        await protection.audit('session.created','owner_login',protection.source(req));
        redirect(res,next,[setCookie(sessionName,sign({token,expires,owner:fingerprint()}),8*3600),setCookie(challengeName,'',0,'Strict')]);return true;
      }
      const session=unpack(cookie(req,sessionName));let valid=false;
      if(session?.token&&session.expires>clock()&&equal(session.owner,fingerprint())) {
        const result=await pool.query('SELECT expires_at FROM commerce_hub_sessions WHERE token_hash=$1',[digest(session.token)]);
        valid=Number(result.rows[0]?.expires_at)>clock();
      }
      if(url.pathname==='/logout') {
        if(req.method!=='POST'){json(res,405,'Use the Sign out button.');return true;}
        if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){json(res,403,'Cross-site sign-out is not accepted.');return true;}
        if(session?.token)await pool.query('DELETE FROM commerce_hub_sessions WHERE token_hash=$1',[digest(session.token)]);
        if(valid)await protection.audit('logout.success','owner_request',protection.source(req));
        redirect(res,'/login',setCookie(sessionName,'',0));return true;
      }
      const callback=req.method==='GET'&&(/^\/oauth\/(amazon|ebay|shopify)\/return$/.test(url.pathname)||url.pathname==='/oauth/amazon/login');
      if(valid){
        if(url.pathname==='/api/security'&&req.method==='GET'){
          if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==origin){json(res,403,'Cross-site requests are not accepted.');return true;}
          const events=await protection.recent();res.writeHead(200,{...security,'Content-Type':'application/json'});res.end(JSON.stringify({events,retentionDays:30}));return true;
        }
        req[authenticatedOwner]=true;return false;
      }
      if(callback)return false;
      if(req.method==='GET'&&(url.pathname==='/'||/^\/oauth\/(amazon|ebay|shopify)\/(complete|continue)$/.test(url.pathname)))redirect(res,`/login?expired=1&next=${encodeURIComponent(safeNext(req.url))}`);
      else json(res,401,'Your session has expired. Sign in again.');
      return true;
    }
  };
}

