import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffEnvelope,simulateDelivery} from '../wake-contract.mjs';
const request={id:'r0067-fixture-r1',spec:{paperId:'r0067',owner:'fixture-thread'}},state={decision:{id:'fixture-decision'}};
test('wake envelope is deterministic and never overrides model or reasoning',()=>{const a=handoffEnvelope(request,state),b=handoffEnvelope(request,state);assert.equal(a.idempotencyKey,b.idempotencyKey);assert.equal(a.modelOverride,null);assert.equal(a.reasoningOverride,null);assert.equal(a.status,'not_connected');});
test('unconnected Desktop delivery fails closed without calling adapter',async()=>{let called=false;await assert.rejects(()=>simulateDelivery(handoffEnvelope(request,state),{deliver(){called=true;}},{threadId:'fixture-thread'}),e=>e.code==='WAKE_NOT_CONNECTED');assert.equal(called,false);});
test('local mock can acknowledge exactly once, without sending a real message',async()=>{const seen=new Map(),adapter={fixture:true,async deliver(e){if(!seen.has(e.idempotencyKey))seen.set(e.idempotencyKey,{fixture:true,owner:e.threadId});return seen.get(e.idempotencyKey);}},env=handoffEnvelope(request,state);await simulateDelivery(env,adapter,{fixture:true,threadId:'fixture-thread'});await simulateDelivery(env,adapter,{fixture:true,threadId:'fixture-thread'});assert.equal(seen.size,1);});
