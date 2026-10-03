import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch;});
const env={ADMIN_TOKEN:'fixture-secret',BOT_STORE:{get:async()=>null,put:async()=>{}}};
const context={waitUntil:()=>{}};
function request(message='Christmas photos for my kids'){return new Request('https://example.test/api/chat',{method:'POST',headers:{origin:'https://motiontography.com','content-type':'application/json'},body:JSON.stringify({message,previous_response_id:'resp_expired'})});}
test('website questions use the governed current-package gateway without the stale KB or a direct model call',async()=>{
  let calls=0;
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://motiontography-pwa-production.up.railway.app/api/website-chat');assert.equal(init.headers.Authorization,'Bearer fixture-secret');assert.equal(JSON.parse(init.body).previous_response_id,'resp_expired');return Response.json({ok:true,reply:'How old are your children?',response_id:'resp_new',used_openai:true,model_used:'gpt-6-luna',followups:[],escalated:false});};
  const response=await worker.fetch(request(),env,context);const body=await response.json();assert.equal(response.status,200);assert.equal(body.used_openai,true);assert.equal(body.model_used,'gpt-6-luna');assert.equal(calls,1);
});
test('outage, malformed and empty upstream answers provide contact options without old prices',async()=>{
  for(const response of [new Response('unavailable',{status:503}),Response.json({ok:true,reply:''}),new Response('bad json')]){
    globalThis.fetch=async()=>response;
    const body=await(await worker.fetch(request(),env,context)).json();assert.equal(body.ok,true);assert.equal(body.escalated,true);assert.match(body.reply,/757-759-8454/);assert.doesNotMatch(body.reply,/\$\d/);assert.equal(body.response_id,null);
  }
});
