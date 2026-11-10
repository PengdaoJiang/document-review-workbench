# Research progress and workflow improvement

The research unit is a claim with its source, quantifiers, conditions, dependencies and remaining obligations. A reconstructed formula or a finished numerical run is an input to that unit; it does not close all of its obligations.

## A concrete research cycle

1. Inventory formulas, assumptions, algorithms and experimental claims independently of the produced draft. Bind obligations to exact source ranges and versions.
2. Assign reconstruction, derivation checks, numerical reproduction and counterexample search with explicit evidence requirements. Independent review receives the material appropriate to its role.
3. Read complete sections through resumable bounded pages. Keep the conditions attached when a section spans several tool responses.
4. Record conclusions, disagreements and unanswered premises against the current dependencies. When an input changes, revisit affected obligations while retaining still-valid work.
5. Use the observed source-reading and review failures to change task decomposition, context interfaces and acceptance rules. Adopt the change in subsequent research tasks and inspect the resulting behavior.

For example, a claim about convergence under a bounded parameter range should retain that range in the obligation and reading packet. A successful numerical run at one point supplies evidence for that point. The general claim remains open until the applicable mathematical and experimental obligations are addressed. Changing the range should identify dependent claims rather than invalidate every unrelated conclusion.

## Two levels of work

Research advancement chooses the next unresolved scientific question and evaluates its evidence. Architecture maintenance changes the task protocol, reading interface or tool implementation when actual runs expose repeated rework. Separating those responsibilities allows the research to resume from valid conclusions while its execution method improves.

The source workflow evolved through exact range/condition binding, complete budgeted reads and dependency-aware delta review. These are inspectable mechanisms in [`coverage_runtime/`](../coverage_runtime/), described in the [coverage guide](obligation-coverage.md). They turn review findings into changes that later tasks can use, rather than accumulating status summaries.

## Where the implementation lives

The coverage runtime handles source inventory, obligations, dependency changes, bounded reads and recovery. The review application separately supplies durable assignments, source/blind review, range lineage and human decisions. Its store, queues and UI retain responsibility and revision identity through interruptions. These are independently runnable components; the public distribution does not claim one deployed integrated autonomous research service.

Scientific judgment still requires an applicable derivation, experiment or review. The useful automation is maintaining the research obligations and handing the next task the right unresolved problem with its conditions and prior valid evidence.
