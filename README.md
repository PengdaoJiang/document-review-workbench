# Research Review Workbench

A durable workbench for reconstructing technical documents, reviewing their claims independently, and retaining human decisions across revisions. It separates research progress from execution state so a completed worker does not by itself close a scientific question.

## Two connected concerns

| Layer | Responsibilities | Entry point |
| --- | --- | --- |
| Review application | Source/blind worker queues, document snapshots, previews, revision-bound human decisions and publication | `server.mjs`, `lib/`, `public/` |
| Claim-level research workflow | Source inventory, exact evidence binding, review obligations, dependency changes, bounded reads and recovery | [Coverage runtime](docs/obligation-coverage.md) |

The source workflow uses review findings to refine task decomposition, reading interfaces and acceptance rules. The implementation retains the resulting mechanisms: changes identify affected obligations, valid earlier conclusions can be reused, and unresolved disagreements stay visible.

## Offline start

Node.js 22+; no npm runtime dependencies.

```sh
npm run setup
npm test
npm run demo
npm start
```

Run `node login-link.mjs` in a second terminal and open its private loopback link. The generated launch key belongs to this local instance; keep it and `data/` private. The default port is 65439. The offline demo creates an original synthetic TeX snapshot and a bound reviewer capability. The browser application starts with an empty human queue.

## Code reading route

- `lib/store.mjs`, `lib/apply.mjs`, `lib/recovery.mjs`: revision-bound decisions, journals, idempotent receipts and crash reconciliation.
- `lib/blind-*`, `lib/source-*`, `lib/review-*`: separate evidence scopes, durable assignments and delivery matching against registered work.
- `lib/paper-writer-registry.mjs`: token/generation ownership; stale observations cannot transfer a live writer's task.
- `lib/human-routing.mjs`, `lib/fragment-human-routing.mjs`, `lib/range-lineage.mjs`: precise edit ranges, focused human decisions and unresolved disagreements.
- `lib/math-request-queue.mjs`, `lib/wolfram-registry.mjs`: durable tool scheduling and exclusive ownership.
- `read-service-worker.mjs`, `lib/read-service.mjs`: a separate read service so polling is independent of slow writes.
- `public/`: source/TeX comparison, drafts, conflict feedback and the execution dashboard.

For incremental research, start with the [coverage guide](docs/obligation-coverage.md). It explains independent source inventory, dependency-aware review and complete resumable reads under a serialized response budget.

## Deployment and evidence

Model workers, desktop notifications, native compilation and math tools are disabled by default. Live integrations require separately configured tools and deployment admission. The public suite uses synthetic cases; seven upstream tests that depend on private compiled-paper fixtures are outside the distribution.

The application is a loopback workbench with Host/Origin, CSRF and capability checks. Its evidence model distinguishes saved decisions, successful tool execution, claim correctness and whole-document approval. Original papers, production documents, credentials and machine configuration remain private.

[MIT](LICENSE). Existing dependency and tool notices continue to apply.
