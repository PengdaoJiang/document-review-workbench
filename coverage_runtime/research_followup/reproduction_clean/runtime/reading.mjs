// Select the approved transcription, not a new academic authority. No file is
// copied or rendered here, and no interpretation from its mapping is exposed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyInput, getDotInput} from './inputs.mjs';
import {getApprovedEdition, getCurrentEdition} from '../../../paper_library/library.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const insist = (ok, message) => { if (!ok) throw new Error(message); };

function checkedFile(reference) {
  insist(reference && path.isAbsolute(reference.path ?? '') && /^[a-f0-9]{64}$/.test(reference.sha256 ?? ''), 'Invalid reading resource reference');
  let current = path.resolve(reference.path);
  while (true) {
    insist(!fs.lstatSync(current).isSymbolicLink(), 'Redirected reading resource rejected');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  insist(fs.statSync(reference.path).isFile() && hash(fs.readFileSync(reference.path)) === reference.sha256, 'Reading resource hash mismatch: ' + reference.path);
  return {path: reference.path, sha256: reference.sha256};
}

function viewFrom(input, edition) {
  const original = {...checkedFile(input.packet.source), pages: input.packet.source.pages};
  if (edition) {
    insist(edition.paperId === input.packet.paperId && edition.source.sha256 === original.sha256 && path.resolve(edition.source.path) === path.resolve(original.path), 'Approved edition is not bound to this paper original');
  }
  return {
    schemaVersion: edition?.provider === 'dot' ? 2 : 1, paperId: input.packet.paperId,
    originalPacket: {path: input.path, sha256: input.sha256},
    mode: edition?.provider === 'dot' ? 'dot_latex' : edition ? 'approved_latex' : 'original_pdf',
    primary: edition ? checkedFile(edition.latex) : {path: original.path, sha256: original.sha256},
    edition: edition ? {version: edition.version, recordPath: edition.recordPath, recordSha256: edition.recordSha256,
      ...(edition.provider === 'dot' ? {provider: 'dot', release: edition.release, indexSha256: edition.indexSha256, selection: 'user_selected_dot_reconstruction'} : {})} : null,
    assets: edition ? edition.assets.map(checkedFile) : [],
    // Only new workflow editions add this field: historical frozen schema-1
    // views remain byte-compatible, including their original property order.
    ...(edition?.provider === 'dot' || edition?.record.schemaVersion === 2 ? {dependencies: edition.dependencies.map(checkedFile)} : {}),
    ...(edition?.provider === 'dot' ? {latexEntries: edition.latexEntries.map(checkedFile)} : {}),
    original,
  };
}

/** Read this view before loading academic content. The TeX is the default only
 * after library acceptance under the user's applicable authorization;
 * original/slices/images and sealed TeX dependencies remain available on demand.
 * A registered but damaged edition throws rather than silently falling back.
 */
export function getReadingView(projectRoot, paperId, options = {}) {
  const {input, edition} = getReadingInput(projectRoot, paperId, options);
  if (options.version !== undefined) insist(edition, 'Requested approved reading edition is unavailable');
  return viewFrom(input, edition);
}

export function getReadingInput(projectRoot, paperId, options = {}) {
  const edition = getCurrentEdition(projectRoot, paperId, options);
  const input = edition?.provider === 'dot' ? getDotInput(projectRoot, paperId, edition) : verifyInput(projectRoot, paperId);
  return {input, edition};
}

/** Runtime-only validation against the independently verified frozen packet.
 * The caller verifies that packet's bytes and original source authority first.
 * Never reselect the latest edition: a frozen PDF run stays a PDF run, and an
 * approved-TeX run remains bound to the exact originally selected version.
 */
export function verifyReadingSnapshot(projectRoot, view, verifiedInput) {
  insist([1, 2].includes(view?.schemaVersion) && view.paperId === verifiedInput.packet.paperId, 'Frozen reading identity mismatch');
  insist(view.mode === 'original_pdf' || view.mode === 'approved_latex' || view.mode === 'dot_latex', 'Invalid frozen reading mode');
  let edition = null;
  if (view.mode === 'approved_latex') {
    insist(typeof view.edition?.version === 'string', 'Frozen reading edition version is missing');
    edition = getApprovedEdition(projectRoot, view.paperId, {version: view.edition.version});
    insist(edition, 'Frozen approved reading edition is unavailable');
  } else if (view.mode === 'dot_latex') {
    insist(view.schemaVersion === 2 && view.edition?.provider === 'dot' && typeof view.edition.release === 'string', 'Frozen Dot selection is missing');
    edition = getCurrentEdition(projectRoot, view.paperId, {version: view.edition.version, release: view.edition.release, indexSha256: view.edition.indexSha256});
    insist(edition?.provider === 'dot', 'Frozen Dot edition is unavailable');
  }
  const expected = viewFrom(verifiedInput, edition);
  insist(json(view) === json(expected), 'Frozen reading view changed or no longer matches its bound resources');
  return {valid: true, mode: view.mode, version: view.edition?.version ?? null};
}
