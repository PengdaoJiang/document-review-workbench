import test from 'node:test';import assert from 'node:assert/strict';
import {currentToolEvidence} from '../public/blind-view.js';
test('blind dashboard follows the actual conclusion receipt and never presents a prior retry as current',()=>{
 const checked={id:'current',evidence:{assessment:'symbolic_inequality'}},old={id:'old',evidence:{assessment:'unresolved_symbolic'}};
 const report={status:'source_anomaly_preserved',mathResult:{toolReceiptId:'current'},toolEvidence:[checked,old]};
 assert.equal(currentToolEvidence(report),checked);
 assert.equal(currentToolEvidence({...report,status:'math_queued',mathResult:undefined,toolReceiptId:'old',previousMathResults:[report.mathResult]}),undefined);
 assert.equal(currentToolEvidence({...report,mathResult:{outcome:'unknown',toolReceiptId:null}}),undefined);
});
