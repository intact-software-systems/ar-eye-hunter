# Recipe Console Browser-Agent Launch Usability Report

Status: moderated-human evidence pending; this file deliberately does not claim
parity or cutover

Implementation under test: working tree based on `2cb772057dab`

## Task

Give each participant only this instruction:

> Open three local browser agents, run Composite Evidence as a distributed recipe, and show the running result in Monitor.

Do not explain the button order.

## Automated interaction evidence

The deterministic Playwright acceptance starts from a cold
`experience=recipe-console&view=execute` URL and uses visible labels and
role/name clicks only. Its intended click sequence is:

1. Composite Evidence
2. Open 3 browser agents
3. Resolve 3 targets
4. Create draft
5. Stage 3 agents
6. Review and start
7. Start distributed run
8. Monitor run

The test contains no DOM-evaluated click, direct lifecycle API call, history
mutation, happy-path Refresh click, or legacy navigation. Separate browser
tests cover wholly and partially blocked popups, whole-cohort and individual
Copy links, missing run/prefix gating, and the browser-rallar login gate. The
configured-live proof logs in, opens three fresh-session browser-rallar tabs
through current UI controls, completes the distributed lifecycle through
Monitor, and checks unique session identities, scrubbed child URLs, and a
secret-free artifact. Automated evidence proves mechanics, not human
comprehension.

Qualification on 2026-07-15 passed 276 focused unit tests, 79 control-server
tests, 200/200 available Recipe Console browser cases (with the configured-live
case separately enabled and passed), four focused launch cases, 30 legacy
launch/navigation cases, shared/app TypeScript, and the 818-module production
build.

The exact aggregate `npm run test:rallar:full-stack:postgres:distributed`
command remains 3/4: the new current-UI configured-live case and both simulated
distributed cases pass, while the separately owned legacy Distributed Recipes
live-RTC case still fails because its panel does not contain
`room.black-box.rtc-realtime.position`. This report does not waive that wider
qualification failure.

## Moderated protocol

Recruit five representative operators:

- two familiar with legacy runner recipes;
- three Recipe Console-only or launch-flow-naive operators;
- three desktop/pointer sessions;
- one keyboard-only session;
- one phone/touch session using Copy links.

Record only anonymized control names and click order, time to first relevant
action, hesitations longer than five seconds, backtracking/misclicks, stated
current phase, completion/abandonment, and facilitator intervention. Never
record URLs, clipboard contents, credentials, tokens, tickets, or raw
console/network data.

## Acceptance criteria

- 5/5 complete without entering legacy.
- Median no more than eight intentional clicks from recipe selection to Monitor.
- At least 4/5 identify the next action within five seconds at each stable phase.
- Nobody needs Refresh on the happy path.
- Nobody attempts Create before Resolve or Start before ready.
- No more than one backtrack or misclick per participant.
- Keyboard and mobile participants complete without focus loss or hidden actions.

## Results

Not yet conducted. Record the exact built commit, browser/device/input mode,
sanitized observations, criterion totals, failures, and resulting design changes
here. A failed criterion requires a design iteration and repeat of the affected
scenario; it cannot be waived in prose.

Until this section records a passing moderated study, the migration-register
human-usability gate remains open and legacy Recipes remains available.
