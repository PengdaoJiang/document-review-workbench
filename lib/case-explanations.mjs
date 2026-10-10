import fs from 'node:fs';
import path from 'node:path';
import {readJSON,hashObject} from './io.mjs';

// Presentation only: no queues, model invocation, source writes or decisions.
export function explanationFields(human){
  const result=[];
  const add=(value,path)=>{if(typeof value==='string'&&value)result.push({path,source:value});};
  for(const [i,row] of (human?.sourceDisposition||[]).entries()){
    const kind=row.disposition?'disposition':'observation',value=row[kind];
    if(value)for(const key of ['explanation','reason','note'])add(value[key],`sourceDisposition.${i}.${kind}.${key}`);
  }
  for(const [i,row] of (human?.blindFindings||[]).entries()){
    for(const key of ['question','evidence','conditions'])add(row[key],`blindFindings.${i}.${key}`);
    if(row.mathResult)for(const key of ['explanation','reason'])add(row.mathResult[key],`blindFindings.${i}.mathResult.${key}`);
    for(const [j,review] of (row.reviews||[]).entries())for(const key of ['explanation','note','reason'])add(review[key],`blindFindings.${i}.reviews.${j}.${key}`);
  }
  return result;
}
export const explanationBinding=request=>hashObject({id:request.id,intentDigest:request.intentDigest,version:request.version,humanEscalation:request.humanEscalation});
export function loadCaseExplanations(root){
  const file=path.join(root,'localization/case-explanations.zh-CN.json');
  try{const catalog=readJSON(file);return catalog.schemaVersion===1&&catalog.locale==='zh-CN'?catalog:null;}catch{return null;}
}
export function localizeCaseExplanations(request,catalog){
  if(!request.humanEscalation)return null;
  const sourceBinding=explanationBinding(request),bound=catalog?.cases?.[request.id],fields=explanationFields(request.humanEscalation),current=bound?.sourceBinding===sourceBinding;
  const translated={},missing=[];
  for(const field of fields){
    const key=current?bound.fields?.[field.path]:null,entry=key?catalog.entries?.[key]:null;
    const valid=entry&&key===hashObject(field.source)&&entry.source===field.source&&typeof entry.zh==='string'&&entry.zh.trim()&&entry.translationSha256===hashObject(entry.zh)&&Array.isArray(entry.verbatim)&&entry.verbatim.every(span=>span&&Number.isInteger(span.start)&&Number.isInteger(span.end)&&span.start>=0&&span.end>span.start&&span.end<=field.source.length&&field.source.slice(span.start,span.end)===span.text&&entry.zh.includes(span.text));
    if(valid)translated[field.path]=entry.zh;else missing.push(field.path);
  }
  return {locale:'zh-CN',status:missing.length?(bound&&!current?'stale':'incomplete'):'complete',sourceBinding,fields:translated,total:fields.length,available:Object.keys(translated).length,missing};
}
