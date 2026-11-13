import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';

export const AUTH_WINDOW=15*60*1000;
export const AUDIT_RETENTION=30*24*60*60*1000;
// Heroku appends the originating address to any supplied X-Forwarded-For chain.
// The caller accepts only the configured host and HTTPS Heroku forwarding path.
export function sourceAddress(req) {
  const last=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();
  const value=isIP(last)?last:req.socket?.remoteAddress||'unknown';
  if(isIP(value)===6)return new URL(`http://[${value}]/`).hostname.slice(1,-1);
  return value;
}

export async function createSecurity({pool,env,clock=Date.now}) {
  await pool.query('CREATE TABLE IF NOT EXISTS commerce_hub_auth_limits (bucket TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_started BIGINT NOT NULL, blocked_until BIGINT NOT NULL, next_allowed_at BIGINT NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS commerce_hub_login_challenges (token_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS commerce_hub_request_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_started BIGINT NOT NULL, expires_at BIGINT NOT NULL)');
  await pool.query("CREATE TABLE IF NOT EXISTS commerce_hub_security_audit (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'owner', event TEXT NOT NULL, reason TEXT NOT NULL, source_hash TEXT NOT NULL, created_at BIGINT NOT NULL)");
  await pool.query('CREATE INDEX IF NOT EXISTS commerce_hub_security_audit_created ON commerce_hub_security_audit(created_at)');
  const hash=value=>createHmac('sha256',env.SESSION_SECRET).update(value).digest('hex');
  const source=req=>hash(`source:${sourceAddress(req)}`);
  const accountBucket=`account:${hash(env.OWNER_USER)}`;
  const audit=async(event,reason,sourceHash,db=pool)=>db.query('INSERT INTO commerce_hub_security_audit(event,reason,source_hash,created_at) VALUES($1,$2,$3,$4)',[event,reason,sourceHash,clock()]);
  let cleanupAfter=0;
  async function cleanup() {
    const now=clock();if(now<cleanupAfter)return;cleanupAfter=now+60000;
    try {
      await pool.query('DELETE FROM commerce_hub_login_challenges WHERE expires_at <= $1',[now]);
      await pool.query('DELETE FROM commerce_hub_request_limits WHERE expires_at <= $1',[now]);
      await pool.query('DELETE FROM commerce_hub_auth_limits WHERE window_started < $1 AND blocked_until < $2',[now-AUTH_WINDOW,now]);
      await pool.query('DELETE FROM commerce_hub_security_audit WHERE created_at < $1',[now-AUDIT_RETENTION]);
    }catch{cleanupAfter=0;throw new Error('Security storage unavailable.');}
  }
  return {
    source,audit,
    async requestLimit(req) {
      await cleanup();const now=clock(),key=source(req);
      const category=req.url?.startsWith('/api/health')?'health':req.method==='POST'?'actions':'requests';
      const maximum=category==='health'?30:category==='actions'?60:180;
      const result=await pool.query(`INSERT INTO commerce_hub_request_limits(bucket,count,window_started,expires_at) VALUES($1,1,$2,$3)
        ON CONFLICT(bucket) DO UPDATE SET
        count=CASE WHEN EXCLUDED.window_started>=commerce_hub_request_limits.expires_at THEN 1 ELSE commerce_hub_request_limits.count+1 END,
        window_started=CASE WHEN EXCLUDED.window_started>=commerce_hub_request_limits.expires_at THEN EXCLUDED.window_started ELSE commerce_hub_request_limits.window_started END,
        expires_at=CASE WHEN EXCLUDED.window_started>=commerce_hub_request_limits.expires_at THEN EXCLUDED.expires_at ELSE commerce_hub_request_limits.expires_at END RETURNING count,expires_at`,[`${category}:${key}`,now,now+60000]);
      const row=result.rows[0];
      if(row.count>maximum){if(row.count===maximum+1)await audit('request.blocked',category,key);return Math.max(1,Math.ceil((Number(row.expires_at)-now)/1000));}
      return 0;
    },
    async issueChallenge(value,expires){await pool.query('INSERT INTO commerce_hub_login_challenges(token_hash,expires_at) VALUES($1,$2)',[hash(value),expires]);},
    async login({req,challenge,userMatches,passwordMatches}) {
      const db=await pool.connect(),now=clock(),sourceHash=source(req),sourceBucket=`source:${sourceHash}`;
      let transaction=false;
      try {
        await db.query('BEGIN');transaction=true;
        // Serialize the decision across dynos so concurrent failures cannot race.
        await db.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':commerce_hub_owner_login'))");
        const consumed=await db.query('DELETE FROM commerce_hub_login_challenges WHERE token_hash=$1 AND expires_at>$2 RETURNING token_hash',[hash(challenge),now]);
        let outcome,reason,retryAfter=0;
        if(!consumed.rows.length){outcome='invalid';reason='invalid_challenge';}
        else {
          const result=await db.query('SELECT * FROM commerce_hub_auth_limits WHERE bucket=ANY($1::text[])',[[sourceBucket,accountBucket]]);
          const active=bucket=>{const row=result.rows.find(r=>r.bucket===bucket);return row&&(Number(row.window_started)+AUTH_WINDOW>now||Number(row.blocked_until)>now)?row:{bucket,failures:0,window_started:now,blocked_until:0,next_allowed_at:0};};
          const ip=active(sourceBucket),account=active(accountBucket);
          // Apply the account cooldown before inspecting the username result so
          // status and Retry-After cannot disclose whether a username exists.
          const blockedUntil=Math.max(Number(ip.blocked_until),Number(ip.next_allowed_at),Number(account.blocked_until));
          if(blockedUntil>now){outcome='blocked';reason=Number(ip.blocked_until)>now?'source_lockout':Number(account.blocked_until)>now?'account_lockout':'backoff';retryAfter=Math.ceil((blockedUntil-now)/1000);}
          else if(userMatches&&passwordMatches) {
            outcome='success';reason='credentials_verified';
            await db.query('DELETE FROM commerce_hub_auth_limits WHERE bucket=ANY($1::text[])',[[sourceBucket,accountBucket]]);
          } else {
            outcome='failed';reason='invalid_credentials';
            for(const row of userMatches?[ip,account]:[ip]) {
              row.failures=Number(row.failures)+1;
              const limit=row.bucket===sourceBucket?5:10;
              row.blocked_until=row.failures>=limit?now+AUTH_WINDOW:0;
              row.next_allowed_at=row.bucket===sourceBucket&&row.failures>=3?now+Math.min(30000,1000*2**(row.failures-3)):0;
              await db.query('INSERT INTO commerce_hub_auth_limits(bucket,failures,window_started,blocked_until,next_allowed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(bucket) DO UPDATE SET failures=EXCLUDED.failures,window_started=EXCLUDED.window_started,blocked_until=EXCLUDED.blocked_until,next_allowed_at=EXCLUDED.next_allowed_at',[row.bucket,row.failures,row.window_started,row.blocked_until,row.next_allowed_at]);
              if(row.blocked_until)await audit('login.lockout',row.bucket===sourceBucket?'source_lockout':'account_lockout',sourceHash,db);
            }
          }
        }
        await audit(`login.${outcome}`,reason,sourceHash,db);
        await db.query('COMMIT');transaction=false;return {outcome,reason,retryAfter};
      }catch{if(transaction)await db.query('ROLLBACK').catch(()=>{});throw new Error('Security storage unavailable.');}
      finally{db.release();}
    },
    async recent() {
      const result=await pool.query("SELECT id,event,reason,created_at FROM commerce_hub_security_audit WHERE tenant_id='owner' ORDER BY id DESC LIMIT 100");
      return result.rows.map(row=>({...row,id:String(row.id),created_at:new Date(Number(row.created_at)).toISOString()}));
    }
  };
}

