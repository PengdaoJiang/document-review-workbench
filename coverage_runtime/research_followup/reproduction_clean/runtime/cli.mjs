#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeScope, materializeInput} from './inputs.mjs';
import {createRun, runChunk, verifyRun, finishRun} from './runs.mjs';
import {getReadingInput, getReadingView} from './reading.mjs';
import {loadDotIndex} from '../../../paper_library/dot-library.mjs';
import {validateContract, publishResult, snapshotResultIndex, buildResultIndex} from './results.mjs';

const cleanRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(cleanRoot, '..', '..');
const [command, paper, argument, extra, ...rest] = process.argv.slice(2);
const json = value => console.log(JSON.stringify(value, null, 2));
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const requireThat = (ok, message) => {if (!ok) throw new Error(message);};
function paperDirectory(paperId, area = 'papers') {
  requireThat(/^(origin|r\d{4})$/.test(paperId || ''), 'Expected paperId origin or rNNNN');
  let cursor = cleanRoot;
  for (const part of [area, paperId]) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) requireThat(!fs.lstatSync(cursor).isSymbolicLink(), 'Redirected paper directory');
  }
  return cursor;
}
function paperFile(paperId, relative, area = 'papers') {
  requireThat(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes(':') && !relative.split(/[\\/]/).some(s => !s || s === '.' || s === '..'), 'Expected a file relative to this paper directory');
  let cursor = paperDirectory(paperId, area);
  for (const part of relative.split(/[\\/]/)) {
    cursor = path.join(cursor, part);
    requireThat(!fs.lstatSync(cursor).isSymbolicLink(), 'Redirected paper file');
  }
  return cursor;
}
function prepare(paperId) {
  if (!loadDotIndex(projectRoot)) materializeInput(projectRoot, paperId);
  const input = getReadingInput(projectRoot, paperId).input;
  const work = paperDirectory(paperId);
  fs.mkdirSync(work, {recursive: true});
  const drafts = paperDirectory(paperId, 'drafts');
  fs.mkdirSync(drafts, {recursive: true});
  return {paperId, inputPath: input.path, inputSha256: input.sha256, workDirectory: work,
    reading: getReadingView(projectRoot, paperId),
    resultDraftDirectory: drafts,
    originalSha256: input.packet.source.sha256, sliceGroups: input.packet.slices.length,
    status: 'input_prepared_not_reproduced', freshWorkerRequired: true};
}

try {
  requireThat(rest.length === 0, 'Too many arguments');
  switch (command) {
    case 'init': {
      requireThat(!paper, 'init takes no argument');
      const dot = loadDotIndex(projectRoot);
      if (dot) {
        for (const directory of ['inputs-dot', 'papers', 'runs', 'results', 'drafts']) fs.mkdirSync(path.join(cleanRoot, directory), {recursive: true});
        json({provider: 'dot', release: dot.release, scopePath: dot.indexPath, scopeSha256: dot.indexSha256, counts: {included: dot.index.papers.length}, status: 'source_selection_not_research_admission'});
        break;
      }
      const scoped = initializeScope(projectRoot);
      for (const directory of ['inputs', 'papers', 'runs', 'results', 'drafts']) fs.mkdirSync(path.join(cleanRoot, directory), {recursive: true});
      json({scopePath: scoped.path, scopeSha256: scoped.sha256, counts: scoped.scope.counts, status: 'scope_registered_not_a_completion_claim'});
      break;
    }
    case 'prepare':
      requireThat(!argument, 'prepare takes one paperId'); json(prepare(paper)); break;
    case 'prepare-all': {
      requireThat(!paper, 'prepare-all takes no argument');
      const dot = loadDotIndex(projectRoot);
      const scope = dot ? {papers: dot.index.papers} : initializeScope(projectRoot).scope; let slices = 0, created = 0;
      for (const item of scope.papers) {
        const input = dot ? getReadingInput(projectRoot, item.paperId).input : materializeInput(projectRoot, item.paperId);
        slices += input.packet.slices.length; created += Number(input.created ?? false);
      }
      json({papers: scope.papers.length, ...(dot ? {provider: 'dot', release: dot.release} : {packetsCreated: created}), sliceGroups: slices, status: 'inputs_prepared_not_a_completion_claim'});
      break;
    }
    case 'verify-input': {
      requireThat(!argument, 'verify-input takes one paperId');
      const verified = getReadingInput(projectRoot, paper).input;
      json({paperId: paper, valid: true, sha256: verified.sha256, sourceSha256: verified.packet.source.sha256}); break;
    }
    case 'paper':
    case 'verify-reading': {
      requireThat(!argument, `${command} takes one paperId`);
      json(getReadingView(projectRoot, paper)); break;
    }
    case 'handoff': {
      requireThat(!argument, 'handoff takes one paperId');
      const ready = prepare(paper);
      console.log(`为论文 ${paper} 进行独立首轮复现。必须使用无历史继承的新上下文（子代理 fork_turns="none"）。\n` +
        `只读规则：${path.join(cleanRoot, 'AGENTS.md')}\n协议与中性命令：${path.join(cleanRoot, 'README.md')}\n` +
        `本篇中性输入包：${ready.inputPath}\n包哈希：${ready.inputSha256}\n默认读取模式：${ready.reading.mode}\n默认学术入口：${ready.reading.primary.path}\n入口哈希：${ready.reading.primary.sha256}\n固定读取版：${ready.reading.edition?.version ?? '无，使用原文'}\n本篇源码目录：${ready.workDirectory}\n本篇结果草稿目录：${ready.resultDraftDirectory}\n只写本篇这两个目录；runs/results由中性入口管理。\n` +
        '先 verify-reading。按绑定的本篇 TeX 读全文和必要子 TeX/宏；includegraphics 图资产按需读取，不把图或原文屏蔽。用 paper 命令获取当前图资产/原文路径。Dot 是用户选定的重建版本，不冒称旧流程盲审通过。\n' +
        '完整读取本篇固定 Dot 包的正文、必要宏/子文件及包内图件，独立写 contract.json、代码和运行计划。尽量不打开、抽取或渲染原 PDF；只有包内无法解决的具体歧义、实质缺项或有依据的转写疑点才最小范围回查，简记理由即可。公式重要、推导、独立复核或填页码均不是例行回查理由。Dot 中性包没有旧研究切片。\n' +
        'sourceLocations 可用 dot:{version,path,sha256} 绑定读取视图内的学术文件，加 section/equation/label/figure/table/excerpt 语义定位，无需 PDF page；已有可靠页码仍可按旧格式使用。\n' +
        '不可变 packet 中旧的 PDF-only 默认读取文字保留作历史记录；本轮以 AGENTS 和读取视图的 TeX 优先策略为准。只读取本篇文稿/必要宏及图资产，不加载来源映射中的解释性说明。\n' +
        '不得读旧研究结论、旧算法/参数、其他论文结果、synthesis 或 generalization；不得预设统一模型。原文信息不足则记录缺口。\n' +
        '运行只用中性 CLI，明确资源与存储计划。完成报告分别说明命题覆盖、原貌复现、数学核查、反例/未知；不把程序成功当学术 PASS。\n' +
        '本提示仅生成交接文本，不自动启动代理、计算或跨聊天消息。');
      break;
    }
    case 'new-run': {
      requireThat(!extra, 'new-run takes paperId and same-paper plan filename');
      const plan = read(paperFile(paper, argument));
      const input = getReadingInput(projectRoot, paper, plan.readingEditionVersion === undefined ? {} : {version: plan.readingEditionVersion}).input;
      const contract = read(paperFile(paper, 'contract.json'));
      const reading = contract.claims?.some(claim => claim.sourceLocations?.some(loc => loc.dot))
        ? getReadingView(projectRoot, paper, input.packet.reconstruction
          ? {version: input.packet.reconstruction.version, release: input.packet.reconstruction.release, indexSha256: input.packet.reconstruction.indexSha256}
          : {}) : null;
      validateContract(contract, input.packet, input.sha256, reading);
      const run = createRun(cleanRoot, paper, {...plan, expectedInputSha256: input.sha256});
      json({paperId: paper, runId: run.runId, runDir: run.runDir, status: 'prepared'}); break;
    }
    case 'chunk': {
      requireThat(extra, 'chunk takes paperId runId chunkId; retries are explicit through the runtime API');
      json(await runChunk(cleanRoot, paper, argument, extra)); break;
    }
    case 'retry-chunk': {
      requireThat(extra, 'retry-chunk takes paperId runId chunkId');
      json(await runChunk(cleanRoot, paper, argument, extra, {retry: true})); break;
    }
    case 'finish':
      requireThat(!extra, 'finish takes paperId runId'); json(finishRun(cleanRoot, paper, argument)); break;
    case 'verify-run': {
      requireThat(!extra, 'verify-run takes paperId runId');
      const checked = verifyRun(cleanRoot, paper, argument);
      json({paperId: paper, runId: argument, status: checked.status, chunks: checked.chunks, scientificStatus: 'not_assessed'}); break;
    }
    case 'publish-result': {
      requireThat(!extra, 'publish-result takes paperId and same-paper result draft filename');
      const record = read(paperFile(paper, argument, 'drafts'));
      requireThat(record.paperId === paper, 'Paper identity mismatch');
      json(await publishResult(cleanRoot, record)); break;
    }
    case 'snapshot-index':
      requireThat(paper && !argument, 'snapshot-index takes a new snapshotId'); json(await snapshotResultIndex(cleanRoot, paper)); break;
    case 'status': {
      requireThat(!paper, 'status takes no argument');
      const index = await buildResultIndex(cleanRoot);
      json({...index.counts, meaning: 'Published result versions, not reading status or proof of whole-paper reproduction'}); break;
    }
    default:
      console.log('Commands: init | prepare <paperId> | prepare-all | verify-input <paperId> | paper <paperId> | verify-reading <paperId> | handoff <paperId> | new-run <paperId> <plan.json> | chunk <paperId> <runId> <chunkId> | retry-chunk <paperId> <runId> <chunkId> | finish <paperId> <runId> | verify-run <paperId> <runId> | publish-result <paperId> <draft.json> | snapshot-index <snapshotId> | status');
      if (command && command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
