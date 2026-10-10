import test from 'node:test';
import assert from 'node:assert/strict';
import {problemView} from '../public/state-view.js';
test('legacy verified records hide stale current errors and retain labeled history',()=>{
  const s={status:'verified',problem:'old failure',events:[{type:'verification_failed',at:'before',message:'old failure'},{type:'verified',at:'after'}]};
  assert.equal(problemView(s).current,null);assert.equal(problemView(s).history[0].message,'old failure');assert.equal(problemView(s).history[0].resolved,true);assert.equal(s.problem,'old failure');
});
test('unresolved failures remain visible and retry-in-progress does not claim success',()=>{
  const s={status:'verification_failed',problem:'failed',events:[{type:'verification_failed',message:'failed'}]};
  assert.equal(problemView(s).current,'failed');assert.equal(problemView(s).history[0].resolved,false);
  assert.equal(problemView({...s,status:'applied'}).current,null);assert.equal(problemView({...s,status:'applied'}).history[0].resolved,false);
});
