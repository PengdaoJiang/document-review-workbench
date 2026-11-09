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
| `coverage-reader.mjs`, `coverage-context.mjs` | Bounded navigation, role-scoped context and explicit truncation |
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
