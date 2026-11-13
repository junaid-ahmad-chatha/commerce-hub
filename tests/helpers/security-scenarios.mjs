import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSecurity,AUTH_WINDOW,AUDIT_RETENTION} from '../../lib/security.mjs';

export async function securityScenarios(pool) {
  let now=Date.now();
  const env={OWNER_USER:'owner',SESSION_SECRET:randomUUID()},clock=()=>now;
  let guard=await createSecurity({pool,env,clock});
  const request=ip=>({method:'GET',url:'/',headers:{'x-forwarded-for':ip},socket:{remoteAddress:'127.0.0.1'}});
  const login=async(ip,{valid=false,known=true,challenge=randomUUID()}={})=>{await guard.issueChallenge(challenge,now+600000);return guard.login({req:request(ip),challenge,userMatches:known,passwordMatches:valid});};
  // Unknown names from a noisy source cannot lock the owner out elsewhere.
  for(let i=0;i<5;i++){now+=4000;assert.equal((await login('192.0.2.1',{known:false})).outcome,'failed');}
  assert.equal((await login('192.0.2.1',{valid:true})).outcome,'blocked');
  assert.equal((await login('192.0.2.2',{valid:true})).outcome,'success');
  guard=await createSecurity({pool,env,clock});
  assert.equal((await login('192.0.2.1',{valid:true})).outcome,'blocked','Source lockout survives service recreation');
  now+=AUTH_WINDOW+1;
  assert.equal((await login('192.0.2.1',{valid:true})).outcome,'success','Cooldown expires without manual database changes');
  // A distributed attack still meets the owner account limit.
  for(let i=0;i<10;i++)assert.equal((await login(`198.51.100.${i+1}`)).outcome,'failed');
  guard=await createSecurity({pool,env,clock});
  const lockedOwner=await login('203.0.113.1',{valid:true});
  assert.equal(lockedOwner.reason,'account_lockout');
  assert.deepEqual(await login('203.0.113.1',{known:false}),lockedOwner,'Account cooldown must not reveal the correct username');
  assert.deepEqual(await login('203.0.113.99',{known:false}),lockedOwner,'A fresh source must see the same account cooldown');
  now+=AUTH_WINDOW+1;
  assert.equal((await login('203.0.113.1',{valid:true})).outcome,'success');
  // One signed login challenge can only authorize one concurrent request.
  const challenge=randomUUID();await guard.issueChallenge(challenge,now+600000);
  const concurrent=await Promise.all([1,2].map(()=>guard.login({req:request('203.0.113.2'),challenge,userMatches:true,passwordMatches:true})));
  assert.deepEqual(concurrent.map(r=>r.outcome).sort(),['invalid','success']);
  // Persistent, atomic request counters include a usable Retry-After duration.
  for(let i=0;i<180;i++)assert.equal(await guard.requestLimit(request('203.0.113.3')),0);
  guard=await createSecurity({pool,env,clock});
  assert.ok(await guard.requestLimit(request('203.0.113.3'))>0);
  assert.equal(await guard.requestLimit(request('203.0.113.4')),0);
  now+=60001;assert.equal(await guard.requestLimit(request('203.0.113.3')),0);
  const events=await guard.recent();
  assert.ok(events.some(e=>e.event==='login.lockout'));
  assert.ok(events.some(e=>e.event==='request.blocked'));
  assert.ok(!JSON.stringify(events).includes('203.0.113.'));
  assert.ok(events.every(e=>!('source_hash' in e)));
  now+=AUDIT_RETENTION+1;await guard.requestLimit(request('203.0.113.5'));assert.deepEqual(await guard.recent(),[]);
  return {persistentSourceLimits:true,accountLimits:true,cooldown:true,singleUseConcurrentChallenge:true,requestLimits:true,audit:true,retention:true};
}

