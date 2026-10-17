const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
let calls;
beforeEach(()=>{globalThis[Symbol.for('family-ai.guard.v1')]?.clear();for(const k of Object.keys(process.env))if(k.startsWith('AI_GUARD_')||k==='AI_CALLS_ENABLED')delete process.env[k];calls=[];global.fetch=async()=>{throw new Error('Unexpected network');};});
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=JSON.stringify(v);return this;},end(v){this.body=v;},send(v){this.body=v;}};}

const handler=require('../api/zhipu-token.js');
test('client cannot extend token lifetime and issuance is limited without a login step',async()=>{
 process.env.ZHIPU_API_KEY='test-id.test-secret-not-real';delete process.env.ZHIPU_TOKEN_TTL_SECONDS;process.env.AI_GUARD_PER_DAY='1';
 const req={method:'GET',url:'/api/zhipu-token?expSeconds=999999',query:{expSeconds:'999999'}};
 const res=response();await handler(req,res);assert.equal(res.statusCode,200);
 const body=JSON.parse(res.body);const payload=JSON.parse(Buffer.from(body.token.split('.')[1],'base64url').toString());assert.equal(payload.exp-payload.timestamp,600000);assert.match(res.headers['Cache-Control'],/no-store/);
 const limited=response();await handler(req,limited);assert.equal(limited.statusCode,429);assert.equal(calls.length,0);
});
test('paused token issuance does not call a provider or alter the memory endpoint',async()=>{
 process.env.AI_CALLS_ENABLED='false';const res=response();await handler({method:'GET',url:'/api/zhipu-token'},res);assert.equal(res.statusCode,503);assert.equal(calls.length,0);
});
