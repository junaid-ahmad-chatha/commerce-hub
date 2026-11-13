import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {createOwnerAuth} from './auth.mjs';

export function hostedSettings(env) {
  if(env.COMMERCE_DEPLOYMENT!=='owner-preview')throw new Error('Set COMMERCE_DEPLOYMENT=owner-preview for the protected hosted preview.');
  let origin;try{origin=new URL(env.APP_ORIGIN);}catch{throw new Error('APP_ORIGIN must be the app’s exact HTTPS origin.');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('APP_ORIGIN must be an HTTPS origin without a path.');
  if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required. Hosted data must not use the dyno filesystem.');
  if(!env.COMMERCE_TOKEN_KEY||Buffer.from(env.COMMERCE_TOKEN_KEY,'base64').length!==32)throw new Error('Set a stable COMMERCE_TOKEN_KEY: 32 random bytes encoded in base64.');
  if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32)throw new Error('Set a stable SESSION_SECRET with at least 32 characters.');
  if(!env.OWNER_USER||!env.OWNER_PASSWORD||env.OWNER_PASSWORD.length<20||env.OWNER_USER.includes(':'))throw new Error('Set OWNER_USER and an OWNER_PASSWORD of at least 20 characters.');
  if(env.OAUTH_CALLBACK_ORIGIN&&env.OAUTH_CALLBACK_ORIGIN!==origin.origin)throw new Error('Hosted OAUTH_CALLBACK_ORIGIN must equal APP_ORIGIN.');
  return {origin:origin.origin,host:origin.host};
}
export function postgresOptions(env) {
  const url=new URL(env.DATABASE_URL);
  // Keep URL sslmode parameters from silently replacing explicit TLS settings.
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
  if(env.PGSSL==='disable'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Unencrypted PostgreSQL is allowed only on loopback for testing.');
  return {connectionString:url.toString(),max:3,connectionTimeoutMillis:10000,
    ...(env.PGSSL==='disable'?{ssl:false}:{ssl:{rejectUnauthorized:env.PGSSL_VERIFY!=='false',...(env.PGSSL_CA?{ca:env.PGSSL_CA.replace(/\\n/g,'\n')}:{})}})};
}
class BufferedResponse extends EventEmitter {
  constructor(){super();this.headers={};this.statusCode=200;this.body=Buffer.alloc(0);this.headersSent=false;}
  setHeader(name,value){this.headers[name]=value;}
  writeHead(status,headers={}){this.statusCode=status;Object.assign(this.headers,headers);this.headersSent=true;return this;}
  end(data=''){this.body=Buffer.isBuffer(data)?data:Buffer.from(String(data));this.emit('finish');}
}

// Owner-preview persistence boundary. PostgreSQL is the durable source of truth;
// SQLite is only a temporary transaction engine. Responses are released after COMMIT.
export async function createHostedApp({env=process.env,createApp,pool:providedPool,fetchImpl=globalThis.fetch,clock=Date.now}) {
  const settings=hostedSettings(env);
  const pool=providedPool||new (await import('pg')).Pool(postgresOptions(env));
  await pool.query('CREATE TABLE IF NOT EXISTS commerce_hub_workspace (id INTEGER PRIMARY KEY CHECK(id=1), payload BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('INSERT INTO commerce_hub_workspace(id,payload) VALUES(1,$1) ON CONFLICT(id) DO NOTHING',[Buffer.alloc(0)]);
  const auth=await createOwnerAuth({pool,env,origin:settings.origin,clock});
  const runtimeEnv={...env,NODE_ENV:'production',LOCAL_APP_ORIGIN:settings.origin,OAUTH_CALLBACK_ORIGIN:settings.origin};
  const send=(res,status,data,headers={})=>{
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Strict-Transport-Security':'max-age=31536000',...headers});res.end(JSON.stringify(data));
  };
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(req.headers.host!==settings.host)return send(res,403,{error:'Unexpected application host.'});
    if(String(req.headers['x-forwarded-proto']||'').split(',').at(-1).trim()!=='https')return send(res,400,{error:'Open this application using HTTPS.'});
    try{if(await auth.limit(req,res))return;}catch{return send(res,503,{error:'Security protection is temporarily unavailable. Please retry.'});}
    if(url.pathname==='/api/health'&&req.method==='GET'){
      try{await pool.query('SELECT 1');return send(res,200,{ok:true,mode:'owner-preview',storage:'postgres-snapshot',liveWrites:false});}
      catch{return send(res,503,{ok:false,error:'Persistent storage is unavailable.'});}
    }
    try{if(await auth.handle(req,res,url))return;}catch{return send(res,503,{error:'Sign-in is temporarily unavailable. Please retry.'});}
    let client,directory,app,transaction=false;
    try {
      client=await pool.connect();await client.query('BEGIN');transaction=true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      const row=(await client.query('SELECT payload FROM commerce_hub_workspace WHERE id=1 FOR UPDATE')).rows[0];
      if(!row)throw new Error('Workspace row is missing.');
      const before=Buffer.from(row.payload);
      directory=await mkdtemp(path.join(tmpdir(),'commerce-heroku-'));const filename=path.join(directory,'workspace.sqlite');
      if(before.length)await writeFile(filename,before,{mode:0o600});
      app=createApp({filename,env:runtimeEnv,fetchImpl});
      const buffered=new BufferedResponse();
      await new Promise(resolve=>{buffered.once('finish',resolve);app.server.emit('request',req,buffered);});
      app.store.close();app=null;
      const after=await readFile(filename);
      if(after.length>20*1024*1024)throw new Error('Owner preview workspace exceeded its 20 MB limit.');
      if(!before.equals(after))await client.query('UPDATE commerce_hub_workspace SET payload=$1,updated_at=NOW() WHERE id=1',[after]);
      await client.query('COMMIT');transaction=false;
      if(!res.destroyed){res.writeHead(buffered.statusCode,{'Strict-Transport-Security':'max-age=31536000',...buffered.headers});res.end(buffered.body);}
    } catch {
      if(transaction)try{await client.query('ROLLBACK');}catch{}
      // Do not log database URLs, authorization codes, or credential payloads.
      if(!res.destroyed&&!res.headersSent)send(res,503,{error:'The workspace could not be saved. Please retry. If this continues, check the database connection and capacity.'});
    } finally {
      try{app?.store.close();}catch{}client?.release();
      if(directory){for(const name of ['workspace.sqlite','workspace.sqlite-journal','workspace.sqlite-wal','workspace.sqlite-shm'])await unlink(path.join(directory,name)).catch(()=>{});await rmdir(directory).catch(()=>{});}
    }
  });
  return {server,pool,async close(){await new Promise(resolve=>server.close(resolve));await pool.end();}};
}

