export function ownerRouting(root,paperId,reportId){return `
原文核对后的出口（无需先完成两轮返工）：仍有真实转译歧义，直接提交给人类；明晰且候选忠实，记录原样保留；技术缺件单独报技术问题。不要回盲审争辩科学，不因科学可疑制造转译疑问。
除用户明确暂停、取消或替换本任务外，状态问询和局部澄清后继续处理本报告。结束前核对本报告已入库的 disposition；若登记返工，继续交实际版本、构建和对照回执。仍有技术缺口就保存该报告的 technical_gap。聊天中的答复不能充当持久交付。
具体JSON契约见 ${root.replaceAll('\\','/')}/OWNER_DISPOSITIONS.md。你可在当前安全检查点运行 node "${root.replaceAll('\\','/')}/blind.mjs" disposition --paper=${paperId} --checkpoint --spec=<自己work目录的JSON>。本报告id=${reportId}；绑定自己当前冻结的bundleId、documentSha256及同一semanticId，并使用自己的实际原图核对证据。转译疑单直接技术装单进人工池；若装单失败，只补技术缺件，不重新做学术说服。只有已确认未完工的施工返修在完成后回盲审局部复核。`;
}
