import test from 'node:test';
import assert from 'node:assert/strict';
import {fakePool} from './helpers/hosted-pool.mjs';
import {securityScenarios} from './helpers/security-scenarios.mjs';
import {sourceAddress,createSecurity} from '../lib/security.mjs';

test('security counters, account lockout, single-use challenges and audit survive service recreation',async()=>{
  await securityScenarios(fakePool());
});

test('source throttles use the address appended by Heroku rather than a spoofed leftmost address',()=>{
  const req={headers:{'x-forwarded-for':'1.1.1.1, 192.0.2.4'},socket:{remoteAddress:'127.0.0.1'}};
  assert.equal(sourceAddress(req),'192.0.2.4');
  req.headers['x-forwarded-for']='malformed';assert.equal(sourceAddress(req),'127.0.0.1');
  req.headers['x-forwarded-for']='2001:0db8:0000::0001';assert.equal(sourceAddress(req),'2001:db8::1');
});

test('simultaneous login failures cannot race past progressive throttling; storage failure is closed',async()=>{
  const pool=fakePool(),guard=await createSecurity({pool,env:{OWNER_USER:'owner',SESSION_SECRET:'security-test-key'},clock:()=>100000});
  const req={headers:{'x-forwarded-for':'192.0.2.1'}};
  for(let i=0;i<15;i++)await guard.issueChallenge(`challenge-${i}`,200000);
  const results=await Promise.all(Array.from({length:15},(_,i)=>guard.login({req,challenge:`challenge-${i}`,userMatches:true,passwordMatches:false})));
  assert.equal(results.filter(r=>r.outcome==='failed').length,3);
  assert.equal(results.filter(r=>r.outcome==='blocked').length,12);
  const events=await guard.recent();assert.equal(events.length,15);
  const broken=await createSecurity({pool:{...pool,connect:async()=>{throw new Error('Unavailable');}},env:{OWNER_USER:'owner',SESSION_SECRET:'test-key'}});
  await assert.rejects(()=>broken.login({req,challenge:'unused',userMatches:true,passwordMatches:true}));
});

