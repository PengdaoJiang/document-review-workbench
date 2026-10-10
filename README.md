# Document review workbench

A local, durable review application with a browser UI, immutable document snapshots, separate source/blind-review roles, human decisions and fenced worker ownership. The full application modules and static interface are exported from a working research workflow; this is not only a collection of example prompts.

## Offline start

Node.js 22+; no npm runtime dependencies.

```sh
npm run setup
npm test
npm run demo
npm start
```

After starting the server, run `node login-link.mjs` in a second terminal and open the printed **private loopback link**. Its generated launch key is read from `data/fixture/credentials.json` and consumed by the local UI. Do not publish the link or generated data directory. The default port is 65439. The app starts with an empty human queue; the offline CLI demo creates an original synthetic TeX snapshot and a bound reviewer capability without compiling a document or invoking a model.

## Engineering structure

- `server.mjs`, `read-service-worker.mjs`, `lib/read-service.mjs`: sole-writer business service and a separate read service so polling is not coupled to slow work.
- `lib/store.mjs`, `lib/apply.mjs`, `lib/recovery.mjs`: revision-bound draft/decision lifecycle, journals, idempotent operation receipts and crash reconciliation.
- `lib/blind-*`, `lib/source-*`, `lib/review-*`: source-versus-neutral evidence separation; durable assignments survive fresh worker sessions; delivery is verified against registered work, not inferred from final prose or exit status.
- `lib/paper-writer-registry.mjs`: token/generation ownership. A timeout does not authorize stealing a living writer's work.
- `lib/human-routing.mjs`, `lib/fragment-human-routing.mjs`, `lib/range-lineage.mjs`: focused human decisions, exact edit ranges, current-version binding and explicit unresolved disagreements.
- `lib/math-request-queue.mjs`, `lib/wolfram-registry.mjs`: fair durable tool scheduling and exclusive tool ownership, separate from reviewer reading.
- `public/`: real review UI, source/TeX comparison views, resumable drafts, conflict feedback and execution dashboard.

## Integrations and boundaries

External model workers, desktop notifications, native compilation and math tools are **disabled by default**. No local account, original paper, production PDF, deployment path or historical authorization is included. Configure only tools already installed and authorized in your own environment. Paths in `config.json`, tool admission files and transport records belong to a deployment, not to this repository. The specialized math cleanup adapter is not used by the offline demo.

The public regression suite contains self-contained synthetic cases. Seven upstream integration-test files that require private compiled paper fixtures are not distributed; their behavior must not be represented as publicly reproduced. Production executor code is included, but native compilation and live model behavior need separate integration acceptance. Historical authorization identifiers have been replaced by synthetic values; they confer no authority to send messages or manipulate an existing project.

This is a loopback workbench, not a public multi-tenant service. Preserve its Host/Origin, CSRF and capability checks. A saved decision or successful tool run is not proof of scientific correctness or whole-document approval.
