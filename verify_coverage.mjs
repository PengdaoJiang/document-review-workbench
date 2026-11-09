import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const campaign = path.join(root, 'coverage_runtime/research_followup/network3_campaign');
// Canonicalize Windows 8.3 aliases; retain the implementation's realpath guards.
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'coverage-public-'));
try {
  const tests = fs.readdirSync(path.join(campaign, 'tests')).filter(x => x.endsWith('.test.mjs')).sort();
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4',
    ...tests.map(x => path.join(campaign, 'tests', x))], {
    cwd: root,
    env: {...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
      NETWORK3_REPAIR_IMPLEMENTATION_DIR: campaign},
    stdio: 'inherit', timeout: 900000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const resolved = fs.realpathSync(temp);
  if (resolved !== temp || !path.basename(resolved).startsWith('coverage-public-')) {
    throw new Error('Unexpected temporary directory identity');
  }
  fs.rmSync(resolved, {recursive: true, force: true});
}
