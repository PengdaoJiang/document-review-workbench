import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {check,hashFile} from './io.mjs';
// Desktop updates relocate the bundled CLI. Refresh only a missing executable,
// keeping the paper's engine; never invoke the excluded native editor compiler.
export function currentCompiler(config,engine){
  const original=config.tools[engine];if(fs.existsSync(original))return config;
  if(engine==='xelatex'){
    const candidate=path.join(path.dirname(config.tools.pdflatex),'xelatex.exe');check(fs.existsSync(candidate),'Owner-verified XeLaTeX is unavailable',503,'COMPILER_UNAVAILABLE');
    const probe=spawnSync(candidate,['--version'],{encoding:'utf8',timeout:10000,windowsHide:true});check(probe.status===0&&/XeTeX/i.test(probe.stdout),'Existing XeLaTeX runtime identity differs',503,'COMPILER_CHANGED');
    return {...config,tools:{...config.tools,xelatex:candidate},compilerRebinding:{to:candidate,version:probe.stdout.split(/\r?\n/)[0],sha256:hashFile(candidate),nativeEditorInvoked:false}};
  }
  check(engine==='tectonic','Previously verified compiler is unavailable',503,'COMPILER_UNAVAILABLE');
  check(/[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]tectonic[\\/]tectonic\.exe$/i.test(original),'Configured compiler is missing; arbitrary tool overrides are not replaced',503,'COMPILER_UNAVAILABLE');
  const candidate=process.env.CODEX_TECTONIC_PATH;check(candidate&&path.isAbsolute(candidate)&&fs.existsSync(candidate),'Existing Tectonic CLI could not be located; no install attempted',503,'COMPILER_UNAVAILABLE');
  const probe=spawnSync(candidate,['--version'],{encoding:'utf8',timeout:10000,windowsHide:true});check(probe.status===0&&/tectonic 0\.17\.0/i.test(probe.stdout),'Located compiler differs from the verified Tectonic version',503,'COMPILER_CHANGED');
  return {...config,tools:{...config.tools,tectonic:candidate},compilerRebinding:{from:original,to:candidate,version:probe.stdout.trim(),sha256:hashFile(candidate),nativeEditorInvoked:false}};
}
