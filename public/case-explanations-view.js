const sourceLabels={faithful_source:'确认辨识结果与提交内容一致',faithful_source_anomaly:'确认忠实原文，保留原文中的疑点',transcription_uncertain:'仍有转写歧义'};
const mathLabels={contradiction:'发现矛盾',checked_no_contradiction:'本次检查未发现矛盾',unknown:'尚不能确定',encoding_error:'编码存在技术问题'};
export function explanationText(human,presentation=null){
  if(!human)return '';
  const value=(row,keys,base,fallback='')=>{const key=keys.find(k=>row?.[k]);if(!key)return fallback;const original=row[key];return presentation?.fields?.[base+'.'+key]??(presentation?'【此段尚无当前版本的中文译文，以下为原始说明】\n':'')+original;};
  const lines=[];
  for(const [i,row] of (human.sourceDisposition||[]).entries()){
    const kind=row.disposition?'disposition':'observation',d=row[kind];if(!d)continue;
    lines.push('原文任务：'+(sourceLabels[d.disposition||d.reading]||d.disposition||d.reading||'已保存原文处置'));
    // Some records contain more than one explanation field; none is hidden.
    for(const key of ['explanation','reason','note'])if(d[key])lines.push(value(d,[key],`sourceDisposition.${i}.${kind}`));
  }
  for(const [i,row] of (human.blindFindings||[]).entries()){
    const base=`blindFindings.${i}`;
    lines.push('盲审意见 '+(i+1)+'：'+value(row,['question'],base));
    if(row.evidence)lines.push('依据：'+value(row,['evidence'],base));
    if(row.conditions)lines.push('适用条件：'+value(row,['conditions'],base));
    if(row.mathResult){lines.push('数学／工具结论：'+(mathLabels[row.mathResult.outcome]||row.mathResult.outcome||'已保存'));for(const key of ['explanation','reason'])if(row.mathResult[key])lines.push(value(row.mathResult,[key],base+'.mathResult'));}
    for(const [j,review] of (row.reviews||[]).entries()){
      const keys=['explanation','note','reason'].filter(k=>review[k]);
      lines.push(...(keys.length?keys.map(k=>'后续复核：'+value(review,[k],`${base}.reviews.${j}`)):['后续复核：详见该意见的原始记录。']));
    }
  }
  return lines.filter(Boolean).join('\n\n');
}
export function renderCaseExplanations(human,presentation,root=document){
  root.querySelector('#fragment-evidence').textContent=explanationText(human,presentation||{fields:{}});
  root.querySelector('#fragment-original-evidence').textContent=explanationText(human);
  const state=root.querySelector('#fragment-language-state');
  state.textContent=presentation?.status==='complete'?'中文说明 · 论文引句、公式和代码保留原样':presentation?.status==='stale'?'内容版本已变化，旧译文已停用；请对照下方原始说明。':'部分说明尚无当前版本的中文译文，已明确标出并保留原始说明。';
  state.dataset.status=presentation?.status||'incomplete';
  root.querySelector('#fragment-original-details').open=false;
}
