# Rallar Documentation

Start with the product, then the architecture, then the guide for the job.
Package and app notes stay next to the code they describe. This index links to
them. It does not copy them.

Historical implementation plans are not product documentation.
[plans/README.md](../plans/README.md) says where a written plan belongs. The ALM
design that is still underway lives in `playground/alm/`, starting at
`playground/alm/alm-improvement-plan.md`. Open pull request
[#566](https://github.com/intact-software-systems/ar-eye-hunter/pull/566) still
edits
`docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md`.
The ALM committed-work design and implementation plan for that pull request
exist only on its branch.

## Product

- [Rallar](./product.md) — what the platform is, what each subproduct owns, and
  which kinds of multiplayer it fits.
- [Architecture](./architecture.md) — choices in the current tree, and the
  alternatives those choices refuse.
- [Convergent State And RTC Topology](./rallar-convergent-state-and-rtc-topology.md)
  — durable causal revisions, optimistic snapshot reads, and cross-server
  topology delivery.
- [Group Formation Architecture](./rallar-group-formation-architecture.md) —
  lifecycle policy, admission, activation, and the recipes that pin each
  behavior.
- [Group Lifecycle Cutover Runbook](./rallar-group-lifecycle-cutover-runbook.md)
  — stop, drain, reset, deploy, and rollback for the formation cutover.

## Use

- [Quickstart And Recipes](./rallar-quickstart-and-recipes.md)
- [API Reference](./rallar-api-reference.md)
- [Examples](../examples/README.md)
- [CRDT Guide](./rallar-crdt-guide.md)
- [CRDT Production Hardening Runbook](./rallar-crdt-production-hardening-runbook.md)
- [RallarAI Recipes](./rallar-ai-recipes.md)
- [RallarAI Governance And Evaluation](./rallar-ai-governance-and-evaluation.md)
- [RallarAI Skill Guide](./rallar-ai-skill.md) — operating notes for an agent
  implementing Rallar usage.
- [RallarAI Prompting Guide](./rallar-ai-prompting-guide.md)

## Operate

- [Production Deployment And Branch Controls](./production-deployment.md)
- [Environment Variables](./environment-variables.md)
- [Production Env Hardening Checklist](./production-env-hardening-checklist.md)
- [Troubleshooting Checklist](./rallar-troubleshooting-checklist.md)
- [API-v1 In-Memory Performance Mode](./rallar-api-v1-in-memory-performance-mode.md)
- [RTC RTT Reporting](./rallar-rtc-rtt-reporting.md)
- [Hetzner Distributed Recipes](./rallar-hetzner-distributed-recipes.md)
- [GitHub Free Headless Runbook](./github-actions-black-box-headless-runbook.md)
- [Upgrade Verification Matrix](./upgrade-verification-matrix.md)

## Repo rules

The coding standard lives in
[repo-code-style.md](../.agents/skills/rallar-code-writing/references/repo-code-style.md).
Agents load it through the `rallar-code-writing` skill. Humans review with:

- [Repo Human Style Review Guide](./repo-human-style-guide.md)
- [Repo Code-Style Exception Registry](./repo-code-style-exceptions.md)
- [Production Legacy Exception Registry](./production-legacy-exceptions.md)
- [Test Structure Coupling Exceptions](./test-structure-coupling-exceptions.md)

Agent orientation is `AGENTS.md`. Skills live under `.agents/skills/**`.

## Beside the code

- Browser runtime: `packages/shared-web/browser/README.md`
- Server runtime and persistence: `packages/shared-server/README.md`,
  `packages/shared-server/docs/runtime-navigation.md`,
  `packages/shared-server/docs/persistence-and-replay.md`
- Relic Hunters: `apps/relic-hunters-v1/docs/README.md`
- Black Box: `apps/rallar-black-box/docs/README.md`
- Black-box runner: `packages/shared-test/black-box-runner/README.md`

## Run environment notes

- `npm run test:e2e` and `npm run test:full-stack` start local HTTP servers via
  Playwright (`127.0.0.1` plus local ports).
- In sandboxed environments that block loopback binds, these commands can fail
  with `listen EPERM` even when the code is healthy.
- In normal local or CI environments with loopback bind allowed, both suites
  pass.
