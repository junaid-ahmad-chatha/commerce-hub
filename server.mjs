import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { createStore, DomainError } from './lib/store.mjs';
import { createConnections } from './lib/connections.mjs';
import { hostedSettings } from './lib/hosted.mjs';
import {authenticatedOwner} from './lib/auth.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ filename = path.join(root,'data','commerce.sqlite'), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const hosted=env.NODE_ENV==='production',hosting=hosted?hostedSettings(env):null;
  const store = createStore(filename), csrf = hosted?createHmac('sha256',env.SESSION_SECRET).update(`csrf:${env.OWNER_USER}`).digest('hex'):randomBytes(32).toString('hex');
  const connections = createConnections({db:store.db,directory:filename===':memory:'?null:path.dirname(filename),env,fetchImpl});
  const snapshot = () => ({...store.snapshot(),mode:hosted?'owner-preview':'local',channels:connections.list(),csrf});
  const browserToken = req => /(?:^|;\s*)commerce_oauth=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  const server = http.createServer(async (req,res) => {
    const send = (status,data,type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
        ...(hosted?{'Strict-Transport-Security':'max-age=31536000'}:{}),
        'Referrer-Policy':'strict-origin',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    const redirect = location => {res.writeHead(303,{Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end();};
    try {
      // Loopback binding alone does not protect against DNS rebinding or cross-origin writes.
      const host = req.headers.host || '';
      const forwarded=['x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','cf-connecting-ip'].some(h=>req.headers[h]);
      const isLocal=/^(127\.0\.0\.1|localhost):\d+$/.test(host)&&!forwarded;
      const isHosted=hosted&&host===hosting.host&&String(req.headers['x-forwarded-proto']||'').split(',').at(-1).trim()==='https';
      const requestOrigin=isHosted?hosting.origin:`http://${host}`;
      const callbackHost=new URL(connections.config.callbackOrigin).host;
      if(hosted&&!isHosted)return send(403,{error:'Open the configured HTTPS application address.'});
      if(!isLocal&&host!==callbackHost)return send(403,{error:'Only the configured callback host is accepted.'});
      const url = new URL(req.url,'http://localhost');
      if(req.url.length>32000)throw new DomainError('Request URL too long.',414);
      const oauth=/^\/oauth\/(amazon|ebay|shopify)\/(return|complete|login|continue)$/.exec(url.pathname);
      const publicCallback=oauth&&['return','login'].includes(oauth[2]);
      if(hosted&&!publicCallback&&!req[authenticatedOwner]){
        return send(401,{error:'Sign in to your workspace.'});
      }
      if(oauth&&req.method==='GET') {
        const [,provider,stage]=oauth;
        if(!isLocal&&!isHosted&&!['return','login'].includes(stage))return send(403,{error:'Finish authorization through the local app.'});
        if(stage==='return')return redirect(connections.relay(provider,url.searchParams));
        if(stage==='login'&&provider==='amazon')return redirect(connections.amazonLoginRelay(url.searchParams));
        if(stage==='continue'&&provider==='amazon')return redirect(connections.continueAmazon(url.searchParams,browserToken(req)));
        if(stage==='complete') {
          const pending=connections.attempt(provider,url.searchParams.get('state'));
          try {
            const result=await connections.complete(provider,url.searchParams,browserToken(req));
            return redirect(`${result.returnOrigin}/#connections?result=${result.status==='connected'?'connected':'authorized'}&channel=${provider}`);
          } catch(error) {
            const reason=error instanceof DomainError?error.message:'Authorization could not be completed. Try connecting again.';
            return redirect(`${pending.context.returnOrigin}/#connections?result=failed&channel=${provider}&reason=${encodeURIComponent(reason)}`);
          }
        }
        return send(404,{error:'Authorization route not found.'});
      }
      if(!isLocal&&!isHosted)return send(403,{error:'The public address accepts OAuth callbacks only. Open the dashboard on localhost.'});
      if (req.headers.origin && req.headers.origin!==requestOrigin) return send(403,{error:'Cross-origin requests are not accepted.'});
      // A marketplace redirect chain keeps Sec-Fetch-Site: cross-site when it
      // reaches the dashboard. Permit only the top-level, read-only landing page.
      const dashboardNavigation=req.method==='GET'&&url.pathname==='/'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if (req.headers['sec-fetch-site'] === 'cross-site'&&!dashboardNavigation) return send(403,{error:'Cross-site requests are not accepted.'});
      if (url.pathname === '/api/state' && req.method === 'GET') return send(200,snapshot());
      if (url.pathname === '/api/health' && req.method === 'GET') return send(200,{ok:true,mode:'local',liveConnections:connections.list().some(c=>c.connected),liveWrites:false});
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return send(405,{error:'Use POST for this action.'});
        const token = Buffer.from(req.headers['x-csrf-token'] || '');
        if (token.length !== csrf.length || !timingSafeEqual(token,Buffer.from(csrf))) return send(403,{error:'Refresh the page before making changes.'});
        if (!req.headers['content-type']?.startsWith('application/json')) throw new DomainError('JSON body required.');
        let size=0; const chunks=[];
        for await (const chunk of req) { size += chunk.length; if(size>64000) throw new DomainError('Request too large.',413); chunks.push(chunk); }
        let input; try { input=JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new DomainError('Invalid JSON.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('JSON object required.');
        let result={}; const match=/^\/api\/products\/([^/]+)\/(adjust|map|listing)$/.exec(url.pathname);
        const connectionAction=/^\/api\/connections\/(amazon|ebay|shopify)\/(start|check|disconnect|private)$/.exec(url.pathname);
        if(connectionAction) {
          const [,provider,action]=connectionAction;
          if(action==='start') {
            const browser=browserToken(req)||randomBytes(32).toString('hex');
            result=connections.start(provider,input,browser,requestOrigin);
            res.setHeader('Set-Cookie',`commerce_oauth=${browser}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900${hosted?'; Secure':''}`);
          }
          if(action==='check')result=await connections.check(provider);
          if(action==='disconnect')result=await connections.disconnect(provider);
          if(action==='private')result=await connections.privateConnect(provider,input);
        }
        else if(url.pathname==='/api/demo') store.seedDemo();
        else if(url.pathname==='/api/products') result=store.createProduct(input);
        else if(match) {
          const [,id,action]=match;
          if(action==='adjust') result=store.adjustStock(id,input);
          if(action==='map') store.mapListing(id,input);
          if(action==='listing') store.saveListing(id,input.channel,input);
        }
        else if(url.pathname==='/api/orders') result=store.importOrder(input);
        else if(url.pathname==='/api/orders/transition') store.transitionOrder(input.id,input.status);
        else if(url.pathname==='/api/sync/simulate') result=store.simulateSync(input.failChannel ?? null);
        else return send(404,{error:'Action not found.'});
        return send(200,{result,state:snapshot()});
      }
      if(req.method!=='GET') return send(405,{error:'Method not allowed.'});
      const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/connection-setup':['../docs/CONNECTIONS.md','text/plain; charset=utf-8']};
      const asset=files[url.pathname]; if(!asset) return send(404,{error:'Page not found.'});
      send(200,await readFile(path.join(root,'public',asset[0])),asset[1]);
    } catch(error) {
      if(!(error instanceof DomainError)&&!hosted) console.error(error);
      send(error.status || 500,{error:error instanceof DomainError?error.message:'An unexpected error occurred. Check the local server.'});
    }
  });
  server.on('close',()=>store.close());
  return { server, store, connections };
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const production=process.env.NODE_ENV==='production';
  const app=production?await (await import('./lib/hosted.mjs')).createHostedApp({createApp}):createApp();
  const port=Number(process.env.PORT || 3100);
  app.server.listen(port,production?'0.0.0.0':'127.0.0.1',()=>console.log(`Commerce Hub: ${production?process.env.APP_ORIGIN:`http://localhost:${port}`}/#connections (marketplace writes disabled)`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(production)await app.close();else await new Promise(resolve=>app.server.close(resolve));process.exit(0);});
}

