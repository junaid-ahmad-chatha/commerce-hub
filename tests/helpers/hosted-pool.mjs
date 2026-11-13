// Transactional PostgreSQL transport double. Real SQL is verified separately.
export function fakePool(shared={payload:Buffer.alloc(0)}) {
  shared.sessions??=new Map();shared.challenges??=new Map();shared.authLimits??=new Map();shared.requests??=new Map();shared.audit??=[];shared.queue??=Promise.resolve();
  async function lock(){const previous=shared.queue;let unlock;shared.queue=new Promise(resolve=>unlock=resolve);await previous;return unlock;}
  const clone=()=>({payload:Buffer.from(shared.payload),sessions:new Map(shared.sessions),challenges:new Map(shared.challenges),authLimits:new Map([...shared.authLimits].map(([k,v])=>[k,{...v}])),requests:new Map([...shared.requests].map(([k,v])=>[k,{...v}])),audit:shared.audit.map(r=>({...r}))});
  function execute(sql,args,state) {
    if(sql.startsWith('CREATE ')||sql.startsWith('INSERT INTO commerce_hub_workspace')||sql==='SELECT 1'||sql.startsWith('SET LOCAL')||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.startsWith('SELECT payload'))return {rows:[{payload:Buffer.from(state.payload)}]};
    if(sql.startsWith('UPDATE commerce_hub_workspace')){state.payload=Buffer.from(args[0]);return {rows:[]};}
    if(sql.startsWith('INSERT INTO commerce_hub_sessions'))state.sessions.set(args[0],args[1]);
    else if(sql.startsWith('SELECT expires_at'))return {rows:state.sessions.has(args[0])?[{expires_at:state.sessions.get(args[0])}]:[]};
    else if(sql.startsWith('DELETE FROM commerce_hub_sessions WHERE token_hash'))state.sessions.delete(args[0]);
    else if(sql.startsWith('DELETE FROM commerce_hub_sessions WHERE expires_at')){for(const [key,expires] of state.sessions)if(expires<=args[0])state.sessions.delete(key);}
    else if(sql.startsWith('INSERT INTO commerce_hub_login_challenges'))state.challenges.set(args[0],args[1]);
    else if(sql.startsWith('DELETE FROM commerce_hub_login_challenges WHERE token_hash')){const expires=state.challenges.get(args[0]);if(expires>args[1]){state.challenges.delete(args[0]);return {rows:[{token_hash:args[0]}]};}return {rows:[]};}
    else if(sql.startsWith('DELETE FROM commerce_hub_login_challenges WHERE expires_at')){for(const [key,expires] of state.challenges)if(expires<=args[0])state.challenges.delete(key);}
    else if(sql.startsWith('INSERT INTO commerce_hub_request_limits')){const old=state.requests.get(args[0]),row=!old||old.expires_at<=args[1]?{count:1,window_started:args[1],expires_at:args[2]}:{...old,count:old.count+1};state.requests.set(args[0],row);return {rows:[{...row}]};}
    else if(sql.startsWith('DELETE FROM commerce_hub_request_limits')){for(const [key,row] of state.requests)if(row.expires_at<=args[0])state.requests.delete(key);}
    else if(sql.startsWith('SELECT * FROM commerce_hub_auth_limits'))return {rows:args[0].map(k=>state.authLimits.get(k)).filter(Boolean).map(r=>({...r}))};
    else if(sql.startsWith('INSERT INTO commerce_hub_auth_limits'))state.authLimits.set(args[0],{bucket:args[0],failures:args[1],window_started:args[2],blocked_until:args[3],next_allowed_at:args[4]});
    else if(sql.startsWith('DELETE FROM commerce_hub_auth_limits WHERE bucket')){for(const key of args[0])state.authLimits.delete(key);}
    else if(sql.startsWith('DELETE FROM commerce_hub_auth_limits WHERE window_started')){for(const [key,row] of state.authLimits)if(row.window_started<args[0]&&row.blocked_until<args[1])state.authLimits.delete(key);}
    else if(sql.startsWith('INSERT INTO commerce_hub_security_audit'))state.audit.push({id:(state.audit.at(-1)?.id||0)+1,event:args[0],reason:args[1],source_hash:args[2],created_at:args[3]});
    else if(sql.startsWith('DELETE FROM commerce_hub_security_audit'))state.audit=state.audit.filter(row=>row.created_at>=args[0]);
    else if(sql.startsWith('SELECT id,event,reason,created_at'))return {rows:state.audit.slice(-100).reverse().map(({source_hash,...row})=>row)};
    else throw new Error('Unhandled test database query');
    return {rows:[]};
  }
  return {shared,failCommit:false,async query(sql,args=[]){const unlock=await lock();try{return execute(sql,args,shared);}finally{unlock();}},async end(){},async connect(){
    let staged,unlock;
    return {release(){unlock?.();unlock=null;},async query(sql,args=[]){
      if(sql==='BEGIN'){unlock=await lock();staged=clone();return {rows:[]};}
      if(sql==='COMMIT'){Object.assign(shared,staged);unlock?.();unlock=null;return {rows:[]};}
      if(sql==='ROLLBACK'){unlock?.();unlock=null;return {rows:[]};}
      return execute(sql,args,staged);
    }};
  }};
}

