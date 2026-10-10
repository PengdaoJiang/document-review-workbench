// Legacy export/mock contract retained for historical callers. Actual authorized
// Desktop event delivery is implemented in lib/notifications.mjs.
import {check,hashObject} from './lib/io.mjs';
export function handoffEnvelope(request,state){
  check(state.decision,'No saved decision');
  return {schemaVersion:1,idempotencyKey:hashObject({requestId:request.id,decisionId:state.decision.id,owner:request.spec.owner}),threadId:request.spec.owner,paperId:request.spec.paperId,requestId:request.id,decisionId:state.decision.id,
    prompt:`本机论文批复台已保存 ${request.spec.paperId} 的局部决定 ${state.decision.id}（疑单 ${request.id}）。请在你独占论文目录的安全检查点运行 review_desk 的 inbox/receive/apply 接口核验和处理。保留原决定；目标变更或不唯一时报冲突，不模糊覆盖；重新编译并回传哈希及结果。此消息不是整篇批准，不授权改变模型、扩大论文范围或写其他 owner 的目录。`,
    status:'not_connected',modelOverride:null,reasoningOverride:null};
}
export async function simulateDelivery(envelope,adapter,authorization){
  check(adapter?.fixture===true,'This implementation only permits a local mock adapter',403,'WAKE_NOT_CONNECTED');
  check(authorization?.fixture===true&&authorization.threadId===envelope.threadId,'Mock authorization must name the exact mock owner',403);
  return adapter.deliver(envelope);
}
