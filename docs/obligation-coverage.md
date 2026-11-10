# Incremental research coverage and exact recovery

`coverage_runtime/` contains the maintained coverage workflow from a long-running
literature reconstruction and independent-review project. The existing review
workbench remains a separate application; they are not one integrated service.

## Unit of work

A paper is not complete because a worker exits successfully or reproduces one
figure. Its inventory identifies claims, conditions, derivations and applicable
implementation or simulation obligations. Each obligation has independently
reviewed evidence and an explicit outcome: supported, refuted, not applicable or
unresolved. Whole-document acceptance is a separate transition.

```text
selected source bytes + document revision
  -> independent inventory and source-scope review
  -> exact owner assignment / private work directory
  -> candidate with immutable input, run and result references
  -> independent review with separately owned evidence
  -> supervisor decision on an exact set of obligations
  -> retain valid prior credit; repair impacted or unresolved obligations
```

The extracted campaign uses a fixed 53-document cohort. Tests create that shape
from synthetic identifiers and placeholder source bytes. This release does not
turn the original project into an arbitrary-corpus hosted product.

## Code map

The main modules are in `coverage_runtime/research_followup/network3_campaign/`:

| Code | Responsibility |
| --- | --- |
| `coverage.mjs`, `coverage-core.mjs` | Revisioned ledger, ownership, admission and decisions |
| `coverage-scope.mjs`, `source-binding.mjs`, `source-admission.mjs` | Source identity and scope completeness before acceptance |
| `coverage-reader.mjs`, `coverage-context.mjs` | Bounded navigation, role-scoped context and complete resumable reads |
| `coverage-authoring.mjs`, `coverage-kit.mjs` | Bound candidates that still require independent review |
| `coverage-batch.mjs`, `coverage-guard.mjs` | Bounded delivery and immutable sidecars |
| `coverage-recovery.mjs`, `repair-flow.mjs` | Exact assignment recovery and retained history |
| `protocols/` | Immutable implementations required by registered regressions |

The dependency closure includes `research_followup/reproduction_clean/runtime/`
for selected inputs, reproducible runs and immutable results, plus the neutral
source identity and review support modules in `paper_library/`, `sources/` and
`research_tree/src/`. No source library contents are included.

Changed releases, unknown owners, changed source bindings, missing terminal
receipts and cross-document evidence must fail admission. Constructor evidence
cannot be relabeled independent review. Valid earlier credit is retained only
while its exact dependencies remain valid.

## Reduce repeated context without dropping conditions

The reader binds a `snapshotKey` to the selected paper, role, source and candidate.
It checks that identity again immediately before returning. A changed owner or
candidate requires reopening the view; a page from an old selection cannot be
silently combined with a new one.

Each serialized response, including its metadata, must fit within 16 KiB. A large
`get` returns a content descriptor and a `read` continuation instead of silently
cutting fields. Chunk responses retain the complete object's hash, offsets and
next offset. The reader avoids splitting UTF-16 surrogate pairs and accounts for
UTF-8 response bytes. Reassembling every page recovers the complete selected
object. Combining several individually bounded responses in one tool output can
still exceed the caller's budget; the caller must also bound the combined output.

The delta index distinguishes five cases:

| Category | Reason |
| --- | --- |
| `new` | No corresponding prior obligation |
| `changed` | Definition, assessment or exact dependency basis changed or is missing |
| `dependency_affected` | A transitive dependency changed |
| `unchanged_accepted` | The supervisor accepted it previously and its current basis is unchanged |
| `old_unaccepted` | It is unchanged but was never accepted |

For example, an unchanged claim whose supporting assumption changes needs new
review. An unchanged unresolved claim cannot inherit acceptance. The index is
navigation, not a new decision: it does not waive the independent completeness
check of the original source or expose private reviewer bodies to a constructor.

The production history showed both successful retention of earlier accepted
obligations and renewed context pressure when workers combined oversized reads.
This motivates the return-size contract without claiming that a smaller rules
file guarantees equal savings in model tokens, latency or end-to-end cost.

## Public verification

Node.js 22+, standard library only:

```sh
npm run test:coverage
```

The wrapper runs four independent test-file processes. Fixtures own isolated
temporary directories and create synthetic source bytes, runs, owners and review
records. Canonical temporary paths preserve Windows realpath checks. No model,
scientific kernel, SSH connection or production workspace is needed.

The repair tests target the included current implementation through
`NETWORK3_REPAIR_IMPLEMENTATION_DIR`, replacing an original candidate directory.
Generated work orders use deployment-neutral Python and external-tool wording.
Source hash checks, admission rules and private-review boundaries are retained.

These tests qualify state transitions and provenance enforcement; synthetic
acceptance does not establish scientific truth. Ownership records coordinate
cooperating processes and are not an OS sandbox.

## Distribution

The code and synthetic fixtures are covered by the root MIT license. No paper
PDFs, reconstructed full text, original figures, private review outcomes, live
worker identifiers, research results or conversation transcripts are included.
Node.js, external model clients and scientific tools retain their own licenses
and are not bundled.
