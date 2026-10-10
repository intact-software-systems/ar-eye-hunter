# Production Legacy Exception Registry

This registry records rare production compatibility boundaries that an authorized maintainer has
chosen to retain. Ordinary pull-request work does not edit this file when legacy is removed,
resolved, or minimized.

A retained entry describes only the code and its maintenance policy. It does not copy pull-request
numbers, reviews, plan identifiers, candidate identifiers, commits, digests, or approval receipts.
The merge authority and review history remain in GitHub.

## Retained exceptions

When retention is necessary, add one section headed `path#symbol` with these maintenance facts:

- Path
- Symbol
- Purpose
- Canonical owner
- Consumer dependency
- Why removal is unsafe
- Minimization
- Compatibility tests
- Named owner
- Review or removal condition

### apps/rallar-black-box/src/legacy/shell/tabs/runner-workspace-tab-panels.tsx#RunnerWorkspaceTabPanels

- Path: apps/rallar-black-box/src/legacy/shell/tabs/runner-workspace-tab-panels.tsx
- Symbol: RunnerWorkspaceTabPanels
- Purpose: Adapt current legacy runner workspace/tab navigation to canonical panels while preserving advanced manual/workbench draft lifetime within the legacy experience.
- Canonical owner: RunnerRecipesPanel, RunnerRunsPanel, RunnerFleetPanel, FlowBuilderPanel and RunnerAdvancedPanel in apps/rallar-black-box/src/legacy/runner; the adapter owns tab presentation, not execution, capture, receipts or distributed-run policy.
- Consumer dependency: LegacyAppShell mounts this adapter when resolveAppExperience selects LegacyExperience. Recipe Console Advanced and Monitor diagnostic handoffs use catalog-backed createAdvancedLegacyHref links with diagnostic context and a Recipe Console return route. Current destinations are workspace=black-box-runner with tab=recipes|runs|fleet|builder, or tab=advanced and advancedSurface=workbench|manual|distributed|run-manager|shared-test; existing URL aliases, bookmarked routes and Recipes-to-Runs selection depend on this translation.
- Why removal is unsafe: Current route consumers and in-session manual/workbench drafts still depend on the adapter. The advanced wrapper and its manual/workbench children remain mounted behind hidden containers while LegacyExperience exists, preserving restored values, edited payload/recipe/command text, selected preset/fixture, capture mode and local error. Silently replacing these lifetimes with selected-only mounts would lose state; leaving LegacyExperience unmounts the subtree.
- Minimization: Retain only this named adapter and its subordinate tab presentation functions calling the existing canonical panels. Recipes/runs/fleet/builder and remote distributed/run-manager/shared-test surfaces remain selected-only lazy mounts. RunnerAdvancedPanel retains surface selection and URL synchronization. Do not duplicate execution logic or eagerly mount new surfaces; no exception is granted to the surrounding legacy tree.
- Compatibility tests: tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts cases "opens every registered legacy surface from its alias and contextual route" and "default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions"; packages/tests/rallar-black-box/legacy-boundaries.test.ts for chunk boundaries. A future migration must also demonstrate preserved in-session manual/workbench drafts across navigation; the named tests alone do not prove every draft-state guarantee.
- Named owner: knuthelge
- Review or removal condition: Review when Advanced/Monitor links cease targeting these runner tabs or a canonical replacement can preserve the URL/context/return and draft-lifetime contracts. Remove only after migrating verified consumers and aliases, retaining canonical panel ownership, demonstrating preserved drafts across intended navigation, and proving cold Recipe Console routes do not load or mount the legacy subtree. A changed compatibility contract requires an explicit maintainer decision.

### apps/rallar-black-box/src/legacy/shell/tabs/diagnostic-evidence-tab-panels.tsx#DiagnosticEvidenceTabPanels

- Path: apps/rallar-black-box/src/legacy/shell/tabs/diagnostic-evidence-tab-panels.tsx
- Symbol: DiagnosticEvidenceTabPanels
- Purpose: Adapt current diagnostic tabs to canonical Trace, Event Stream and Server panels while preserving their in-session diagnostic state within the legacy experience.
- Canonical owner: RallarTracePanel, EventStreamPanel, ExecutionFocusPanel and StatsPanel in apps/rallar-black-box/src/legacy/diagnostics/events; RallarServerPanel in apps/rallar-black-box/src/legacy/diagnostics/rallar-server; CommandHistoryPanel in apps/rallar-black-box/src/legacy/runner/advanced; FailurePanel in apps/rallar-black-box/src/legacy/runner/runs. The adapter owns tab presentation, not transport, server requests, receipts or collection policy.
- Consumer dependency: LegacyAppShell mounts this adapter under LegacyExperience selected by resolveAppExperience. Recipe Console Advanced and Monitor handoffs use createAdvancedLegacyHref with catalog IDs direct.rallar-trace, direct.rallar-server and diagnostic.event-stream, context and a Recipe Console return route. Current destinations use workspace=rallar with tab=rallar-trace|rallar-server, or workspace=black-box-runner with tab=event-stream; trace/rallartrace, server and events/event aliases remain current consumers.
- Why removal is unsafe: These route/context consumers and canonical panels' filters, request drafts and results still depend on their mounted lifetime. The three sections remain mounted and hidden outside the selected tab within LegacyExperience. Trace retains source/severity filters and event limit, with active-gated event reading/rendering. React Activity preserves Trace and Event Stream DOM/state while suspending their hidden effects, including the Trace timer, and restores those effects when selected. Event Stream retains stored filters/event limit, with active-gated event reading/rendering and state-driven filter persistence. Server has no active prop and its controller retains request/collection drafts, busy/error/feedback state and results. Leaving LegacyExperience unmounts these panels; retention does not imply all inactive work stops.
- Minimization: Retain only this named tab adapter and its existing Event Stream presentation function, forwarding shell selection/history to the existing canonical panels. Keep diagnostic collection and request business logic in their current owners; do not create duplicate implementations or extend retention to the surrounding legacy tree.
- Compatibility tests: tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts cases "keeps direct Rallar diagnostics out of primary navigation and opens them from Advanced", "opens every registered legacy surface from its alias and contextual route", and "default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions"; packages/tests/rallar-black-box/legacy-boundaries.test.ts for chunk boundaries. A future migration must also demonstrate preserved filters and server request/result state across navigation; route/chunk tests alone do not prove every state guarantee.
- Named owner: knuthelge
- Review or removal condition: Review when Advanced/Monitor links cease targeting these diagnostic tabs or a canonical replacement can preserve their URL/context/return and state-lifetime contracts. Remove only after migrating verified consumers and aliases, retaining canonical panel ownership, demonstrating preserved filters/server drafts/results across intended navigation, and proving cold Recipe Console routes do not load or mount the legacy subtree. A changed compatibility contract requires an explicit maintainer decision.
