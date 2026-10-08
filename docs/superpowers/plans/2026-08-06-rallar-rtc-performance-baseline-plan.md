# Rallar RTC Performance Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task
> with TDD and independent task review. Steps use checkbox (`- [ ]`) syntax for
> tracking. Also use the repository `performance-analysis`, `rallar-realtime`,
> `rallar-code-writing`, `rallar-testing`, `adaptive-plan-execution`, and
> `publishing-plan-progress` workflows.

**Goal:** Produce reproducible, correctness-gated RTC evidence for the accepted
`RTC-B01` through `RTC-B06` workloads, identify what evidence remains missing,
and rank at most one attributable candidate for a separate human decision.
Browser and live-RTC observations form an append-only stream over each run's
immutable snapshot of moving `main`.

**Architecture:** `packages/shared-rtc-bench` is the private measurement owner.
Production RTC behavior remains authoritative in `shared`, `shared-web`, and
`shared-server`; apps consume those packages. Package-owned capture, validation,
finalization, repeat selection, and archive verification preserve each run's
source, environment, exact attempts, raw samples, and checksums. Tooling is
implemented; capture and ranking acceptance remain separate outcomes.

**Current checkpoint, 2026-10-08:** Manual readiness, actual native Copy/repeat,
and the reviewed materializer correction are published in PR645. The correction
preserves authored capture and unrelated strings while translating executable
scope; one shared boundary owns child cancellation and physical cleanup.

Fresh source CI completes the selected correctness/static lanes except tooling:
two assertions identify the moved README fixture's stale owner, and the native
atomic-snapshot case exceeds its existing 5000ms budget. The exact fixture-owner
correction has semantic RED (two failures/eight controls), GREEN (all 10 cases),
and independent SPEC/QUALITY approval. The original failed hosted run remains
retained. Local alternating measurements attribute almost all native-case time
to cold graph/type checking before filesystem effects; the remote deadline phase
was not directly observed. The proposed compile/execution separation must retain
the actual typed fixture, native effects, owned artifacts and every assertion.
No timeout, retry, workload or cache-warmup change is selected.

PR633 has nine conflicts against newly fetched current main. A repair on its feature branch
is locally validated and awaits independent review/publication. The old
exact integration proposal is stale. Complete source correctness and the parent
repair before broad integration validation, then complete HOST/operator RUN
forwarding and actual application through existing workers and Actions. Governed
E3 still has zero accepted cohorts; no default-branch operation is selected.

**Tech Stack:** TypeScript, Deno, Vitest, Node.js, Playwright Chromium, Git,
GitHub Actions, ignored evidence under `tmp/perf/`, and immutable observation ZIPs.

**Spec:** No separate historical specification remains in the current tree.
The accepted measurement contract is retained in Sections 5, 6, and 8 of this
plan. The approved diagnostics amendment is specified in
[RTC establishment diagnostics](../../../plans/active/rtc-establishment-diagnostics.md).
Task61 distributed run intent and Task62 installed capture support/admission are locally
implemented and independently accepted. Task63 finite applied receipt preservation and
required-result admission has completed GREEN implementation after verified semantic RED and
both attribution findings are now closed by the original reviewer with SPEC/QUALITY Approved; Task63 is locally accepted;
Task64 is locally implemented after semantic RED: immutable accepted intent, a pre-effect
acknowledged-load guard, assignment-owned completion/replay, and root/recipe capture
propagation through reload. The initial129 SDK/owner and177 controller passes remain
preserved. Correction round1 now passes140 consumer and177 controller tests, package/test
typing, app build, formatting, navigation and headless boundary checks. The original
reviewer approves the seven corrected owners and closes all four blocking findings:
late reset ownership, authentic child progress, accepted comparison operands, and the
snapshot function's size/duplication. The measured320.778KiB headless boundary uses its
existing minimum adjustable cap321; forbidden dependencies remain excluded. The existing
large-chunk build warning is disclosed. Five fixture corrections now have independent
local acceptance:17 artifact cases, eight unchanged tuning cases and14 native cases pass,
with final typing/format/navigation and whole-file closure. Fresh hosted e088 correctness
confirms the fixture slice:13750 unit passes with one callback failure/12 skips, and360
controller passes/zero failures/one ignored. Headless and ALM checks pass. The original
reference-run callback RED and three related admission/event failures remain preserved.
Their minimum correction is independently accepted:227 affected cases, typing, navigation,
formatting and the headless boundary pass without increasing its321KiB cap. Hosted b0
confirms13758 unit passes/12 skips and all selected correctness jobs; static alone retains
the19 reviewed findings. Local publication closure now passes168 tooling tests and the
full changed-style gate after correcting the existing literal-discount applicability to
JavaScript modules. The same independent reviewer approves all three complete support
owners with no findings; this coherent slice is accepted for prompt feature publication.
Hosted d586 run 37655992935 confirms that repository style now passes and all
selected correctness jobs succeed. Static reaches four unclassified owned I/O
assertions. Their four narrow I/O classifications are independently reviewed and published,
and the committed current-parent style and coupling gates pass. This continuation is published in draft
[PR645](https://github.com/intact-software-systems/ar-eye-hunter/pull/645); Task64's complete
combined-source CI outcome is accepted at its published head
1bbb2b31531e28c5eb82a113833a80eb2782bdee, tree17cd1b67064ea15b3f835e6e75f3062dbb7f0256.
Hosted37664555375/attempt1 passes every other selected correctness/static lane, but the
Postgres job exceeds its20-minute setup limit during Playwright's apt dependency install.
Migrations and tests never start; the dependent result fails on release=cancelled. The
mirror/transport stall's lower-level cause remains unproved. One targeted cancelled-job
rerun succeeds as attempt2: Postgres reaches87 integration cases, topology,4+1 smoke
cases and10+10 presence-expiry cases; publication and final result also succeed. Actual
times/runners prove other successful lanes were carried forward despite renewed IDs.
Formation37664555126 and Medium37664555149 succeed with an equivalent synthetic merge;
all three actual tested trees equal17cd1b67064ea15b3f835e6e75f3062dbb7f0256. Root verifies
the source, artifact and publication bindings. The failed attempt remains preserved and
supplies no Postgres GREEN; newer Task65 working changes receive no acceptance from it.
Publish each coherent validated slice on the feature branch; keep incomplete acceptance
explicit in the draft pull request rather than accumulating accepted slices locally. The WS
fixture correction is independently accepted and published at
`9d683b3ba00cc0a450a8a940ecdd2eab4c55bbed`, with fresh normal hosted correctness accepted.
Its original eleven failed observer cases and their semantic RED/GREEN correction remain
retained. The local Native correctness preflight has six correlated applied receipts with
partial coverage; this is separate from homogeneous performance acceptance. PR633 now has
its five conflicts against pinned main d5db1569d5072a714df314b2d5eceed5011407d5
repaired and published in feature merge 15efff0055e78bd03f06aed243af0aa3a061278f
(tree 372c1f6e21ab768fbb584a03c8e5c3fbfa26fe16). Semantic RED witnessed the
obsolete room-only refusal of valid world fallback; the integrated sender preserves
main audience/fallback behavior and one capture/acquisition with original receipts.
Its mocked initializer witness proves policy/admission, not native ICE establishment.
Independent SPEC/QUALITY review approves six complete owners and removal of the
unused private validation argument. Final 228 behavior and 18 API/bundle cases,
package and 1487-test typing, both app builds and post-merge exact-main-ancestry
style checks pass. The earlier inherited 14-prompt style failure remains preserved.
Fresh measured facade 250.069 KiB and headless 320.244 KiB require existing
adjustable packaging caps 251 and 321; no workload or other limits change.
Fresh Branch37661784882, Formation37661784487 and Medium37661784363 are terminal SUCCESS.
Actual checkout/artifact evidence binds Branch to15eff and the other two to an equivalent
synthetic merge, all with tree372c1f6e21ab768fbb584a03c8e5c3fbfa26fe16. Required review still
blocks ordinary main integration. The previous exact squash proposal against main
d5db1569d5072a714df314b2d5eceed5011407d5 is now stale: remote main has advanced to
94e72f4828e9db5111dc06e4746f1ce09f68ead2. The two real shared-web budget and
update-room test conflicts are now repaired and published in feature merge979edba8,
treef5c9cf3805051f8392306cb5eef34537cf9000ff. Fresh complete-owner review, local checks
and original-attempt Branch37698502492, Formation37698502271, Medium37698502189
and CodeQL37698497321 pass. Root verifies eight original artifact digests,20 checkout
proofs, the published validation receipt and equivalent synthetic merge tree/parents.
PR633 is MERGEABLE; native review is still required. A new exact administrator squash
proposal against main94e72/head979/treef5c9 is prepared and fresh explicit permission
is pending. No main commit, push or accepted E3 cohort is performed.
Local Workbench now has visible run capture intent after two genuine semantic REDs:
first the missing selector, then explicit Off failing to reach the accepted run. Final
32 SDK/store cases, the simulated real-UI browser witness, maintained1488-test typing,
scoped browser typing and app typecheck/build pass. The original independent reviewer
has accepted SPEC/QUALITY and closes both private naming/import findings against the
exact corrected source. The bounded Local slice is published in PR645 at
634c47fef4fe229c3d1382031cca41a8cf55b13e, tree279a83f9a53e82f2438c037850194fa9eb92a0ec;
Git and GitHub heads agree and final current-parent style/coupling gates pass. Fresh
Branch37678344974 selected release lanes/publication/final gate and Formation37678344373
and Medium37678344447 pass on verified identical trees. Branch is terminal cancelled
because separate ALM setup exceeds its30-minute timeout before observation starts;
the failed attempt stays preserved and supplies no ALM or performance acceptance.
Console canonical forwarding now passes80 focused unit cases, the full29-case
browser corpus and three final affected cases. All four choices preserve authored
intent through Resolve/Create/Stage/Start. Fresh independent review approves all
seven complete owners after private naming/dead-local corrections and the exact
outgoing-serializer reviewed-boundary record.83 final focused checks and app typing
pass; the final current-parent WORKTREE style gate passes with no new findings.
The coherent slice is published in PR645 at5375a5559b447c8dda5b90739f466cfeaee91a27,
treebf747f19f9ef6cd875b771da192aef823cdd7962. Git and GitHub heads agree; committed
coupling passes with all nine existing candidates classified. The initial style failure
is preserved. Fresh Branch37690497028, Formation37690496468 and Medium37690496519
attempt1 all pass on independently verified identical trees, without evidence reuse.
The separate ALM job passes three baseline smoke cells; twelve cases are skipped and
per-operation samples remain insufficient. This accepts hosted release evidence for
5375, not a performance baseline. Local Load/remount now has two independently verified
semantic REDs followed by minimum GREEN. The final maintained browser run passes three
cases, including both observer controls. Fresh independent SPEC/QUALITY approves all
three complete owners with no findings; final current-parent WORKTREE style passes.
Local Load/remount is published at379f8aff, followed by the independently reviewed
Copy-to-Local body/lifecycle witness at6a01de7d. Fresh original-attempt Branch,
Formation and Medium correctness for both heads passes on independently verified trees,
without reuse. Actual Local Native refusal passes1/1 in7.4s; the unchanged actual
Manual Native/export/reload/reset case passes1/1 in13.2s. Initial setup failures and
shared-database service errors remain retained; these passes do not establish delivery
or performance acceptance. Full-owner review accepts the new witness. The SAME author removes the redundant
static-heading smoke, proves retained Load/Run/Reset1/1 in16.7s at corrected source,
and the SAME reviewer closes SPEC/QUALITY with no remaining findings. This coherent
tests-only slice is accepted for prompt feature publication.
Worker, Actions and full B01–B06/E3 outcomes stay mandatory.
B06 selection and producer configuration are published; governed E3 has zero accepted cohorts
and remains required in Section 11. Current product and architecture are [docs/product.md](../../product.md)
and [docs/architecture.md](../../architecture.md). The canonical executable
navigation is [Shared RTC Bench](../../../packages/shared-rtc-bench/README.md).

## Global Constraints

- Do not retain affected legacy. Remove predecessor implementations, compatibility aliases/fallbacks, parallel old/new paths and obsolete tests when no independently required public contract or verified consumer requires them. No newly retained legacy is authorized by this task; surface a real compatibility conflict before retaining it.
- Do not add migration code: migration bridges, dual readers/writers, relocation-only work or unchanged predecessor implementations transferred into a new owner. Correct canonical current owners and preserve independently required public/wire/persistence contracts unless the human explicitly authorizes a breaking decision. A genuine consolidation may establish one current owner only when it removes duplicate implementations and exposes an actual responsibility boundary; Task65 specifies its bounded Execute fixture consolidation below.
- Avoid code duplication. Reuse the canonical RTC and evidence owners; benchmark code measures production without reimplementing it, and apps remain consumers.
- Prefer functional over stateful: pure data-in/data-out policy, calculation, translation, and validation; stateful shells only for explicit lifecycle/resource ownership with injected effects.
- Keep the repo consistent. Follow current AGENTS.md, repo-local skills and authoritative standards. Apply full-file closure recursively to remediation support files; independent untouched code stays outside closure.
- Use subagent driven development and TDD for every implementation or bugfix: independent semantic failure, witnessed RED, minimum GREEN, refactor, focused affected checks and independent task review. Human prose needs no artificial source-text test.
- Preserve RTC-B01 through RTC-B06 accepted workloads, environment identities, sample counts, timing boundaries, artifact correctness/failure/confinement/accounting, controlled repeat and homogeneous-comparison rules. RTC-B07 remains held. Moving main observations retain exact immutable source provenance; do not wait for quiet main.
- Capture does not authorize optimization. Diagnose the first failed attempt; only evidenced correctness corrections, proved test-first and independently reviewed, may change production. No speculative watchdog renewal, retry, timeout expansion, workload/sample reduction, or discarded failure.

- The benchmark package is private, has no product barrel, and is never a
  product runtime dependency. Preserve required public product exports and app
  imports; use documented package/root commands for benchmark entry.
- Observation evidence is append-only. Later `main` movement never invalidates
  a verified observation's exact source provenance. A failed primary contributes
  no accepted metrics and is never overwritten, discarded, or repaired in place.
- Use the current repository cognitive-load, responsibility, function/decision,
  and navigation standards. Historical physical-line targets, activation blobs,
  write reservations, and progress ledgers are retired. Git history archives
  the removed execution transcripts.
- Never publish credentials, full environment dumps, authorization headers,
  unredacted remote host inventories, or raw profiles. Keep generated local
  artifacts ignored under `tmp/perf/`; the observation archive is the deliberately
  validated and redacted publication boundary.

## Review Focus

- A passing workflow can publish a failed primary; inspect outcome and complete
  attempts before accepting metrics.
- A passing required repeat can remain noisy; persistent metric CV above the
  threshold is inconclusive and cannot rank that metric.
- A partial retention attempt cannot establish the 100-cycle contract, and
  native Chromium lifecycle evidence cannot establish Rallar reconnect retention.
- A publication credential failure must preserve the original capture for
  verified recovery; it does not justify replacing a measurement or changing RTC.
- A proposed watchdog renewal requires a causal first-failure trace and semantic
  RED/GREEN proof; offer arrival alone does not establish the termination actor.

---

**Created:** 2026-08-06

**Updated:** 2026-10-08

## 1. Current Outcome And Evidence

The preceding published helper checkpoint adopts canonical snapshot, issued-auth and artifact contracts
in the existing browser helpers and callers. Named inputs replace positional compatibility
paths; permissive duplicate decoders are removed. Each acquired browser resource and initiated
recipe observation has explicit lifecycle ownership. Original errors remain reachable when
later evidence collection or disposal also fails. Deadlines, ordering and warning/release policy
are unchanged. Semantic TDD reproduces seven initial resource defects, six post-barrier
observation failures and four originating-error failures. The final five-file run passes all
71 cases, and the existing Local Native consumer passes once with workers1/retries0 under
unchanged budgets. Independent SPEC/QUALITY review closes all helper findings. The 22 exact
boundary dispositions classify validated inputs or opaque error observations; all 111 prior
entries and the checker matcher/thresholds are unchanged. All 88 support semantic cases pass,
and the changed-file WORKTREE gate passes. This checkpoint is published at `5d060850c` in draft
[PR645](https://github.com/intact-software-systems/ar-eye-hunter/pull/645). The unfinished Copy
witness is excluded. Helper acceptance supplies no copied delivery, live-worker or E3 acceptance.

Original hosted Branch37734745172 passes unit, tooling, Deno, browser, API and Postgres checks,
while Static fails three unclassified mock-count assertions in the combined helper
failure-retention test. The changed-style gate passes; the unrelated full-repository warnings
are not the failure. Formation37734744784 and Medium37734744828 pass. The original Static log
is retained. The exact five returned failure identities, original cause and actual resource
closure already prove the attempted cleanup effects; the three counts add incidental call
topology. The correction removes only those counts and their unused spy-result bindings,
retaining all behavioral oracles without an exemption. The exact original committed-range
coupling failure is reproduced before editing. All 24 focused helper boundary cases then
pass, and the current-owner coupling check reports zero candidates with a current registry.
RTC integrity and evidence publication are skipped; this is no full release or E3 acceptance.

The reviewed correction is published at `c729f6e`. Fresh
[Branch37738842047](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37738842047),
[Formation37738841643](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37738841643)
and [Medium37738841652](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37738841652)
pass, including Static. All eight original archive digests and the published receipt match;
the synthetic merge tree and both parents match the exact source. Executed selection is
broad with reuse=false. Hosted Native refusal, delivery and Manual capture cases are skipped,
as is RTC integrity. This resolves the helper Static failure within those correctness gates;
native Copy/repeat and E3 remain separate required outcomes. Original failed attempts remain
retained.

Manual readiness authoring now has passing focused implementation evidence after its
independently reviewed tests-first checkpoint: 35 semantic failures and 51 passing controls.
The earlier storage setup failures remain separate adverse evidence. One optional JSON
editor uses the existing canonical readiness schema and carries the exact accepted value
through Connect, Join, matrix and negative recipes into submitted history. Blank omits the
wait; explicit {} and valid partial objects retain their authored meaning. Invalid RTC
input refuses before submission effects; WS and Send-only actions retain their independence.
The draft restores raw text and Reset clears it through existing owners, without migration.
All 80 original assertions remain preserved. The three rendered authoring cases now reach
and pass their editing, repeated Copy, restored-error and reset checks. A separately retained
callback RED proves that an uninvoked old handler must validate current input, while accepted
history remains immutable. Final focused checks pass 87 Manual cases and 12 schema/Flow
controls, app typing and formatting. Scoped test typing still fails solely on the external
Temporal declaration error, reproduced byte-for-byte on the published baseline. SPEC/TDD
and independent QUALITY review approve this source scope after bounded metadata/fixture
consolidation and declaration placement. The final 99-case focused run passes; the affected
Rallar black-box/shared-test suite passes 4,786 cases across 386 files, and the app build passes
with its existing large-chunk warning. Actual browser/native Copy/repeat and E3 acceptance
remain open.

The original committed style gate found one real missing recipe-result contract and three
raw-JSON boundary findings. The follow-up names all eight result fields with canonical types
and undefined unions only for genuinely absent payload-derived validations. Manual history
always serializes a recipe, so its validation is mandatory and the unreachable empty-text
branch is removed without changing validation behavior. Three exact reviewed dispositions
cover schema-normalized readiness input and the two opaque/schema-validated test oracles;
every prior disposition and matcher remains unchanged. All 99 focused cases and 51 existing
disposition controls pass with no skips. The original failed gate remains retained; no real
standards violation, threshold relaxation or legacy-retention exception is authorized.

The Manual slice is published at `f89a666d`, followed by its reviewed result-contract
and JSON-boundary correction at `4147728a6`. Fresh original-attempt
[Branch37747984192](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37747984192),
[Formation37747983962](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37747983962)
and [Medium37747983933](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37747983933)
pass. Eight original archive digests, the canonical published receipt and18 checkout
proofs bind the exact reviewed tree87604549; synthetic mergeba82bad0 has ordered
parents979edba8/4147728a6 and the same tree. Executed selection is broad with reuse=false.
Unit results are14,180 passed/12 skipped; app-browser results are48 passed/69 skipped,
then7 memory full-stack passes. Hosted Native refusal, delivery and Manual capture cases
remain skipped, as does RTC integrity. This accepts current hosted correctness for the
Manual source, without inheriting acceptance to the separately changing browser witness,
live worker/Actions application, B01–B06 or E3.

The preceding envelope checkpoint consolidates ordinary and distributed artifact validation
in one shared-test incoming schema owner. Mandatory identity, finite version/time and required
string files, plus supplied optional distributed files, are validated at admission. Existing
readers retain content and version-specific policy. Independent SPEC/QUALITY review approves
the correction; all 38 unchanged behavioral assertions pass, and the preceding consolidation
passed the affected 2,636-test shared-test suite. Both newly added predecessor modules are
deleted without compatibility shims. The original hosted directory/prefix failures and the
original broader helper gate failure remain retained as adverse evidence. The subsequent
source review and exact boundary closure resolve that helper gate without a policy relaxation.

The preceding general-worker HOST capture slice remains accepted, published in draft
[PR645](https://github.com/intact-software-systems/ar-eye-hunter/pull/645) at
`46de97d91e30c9beb6215d68a6fe2d8ceb8dec04`, tree
`939c2fa9b53d139b97c5ccbc7ab20ecb106165dc`. Semantic TDD and independent complete-owner
SPEC/QUALITY review accept env/query/bootstrap forwarding, sparse SDK host defaults,
invalid-input refusal and actual SDK mode/origin readback. Local checks and fresh hosted
Branch37714910111, Formation37714909898 and Medium37714909915 pass. Root verifies all eight
original archive digests, the published receipt and equivalent synthetic merge tree/parents.
Actual hosted native/refusal/Manual cases and RTC integrity are skipped. This accepts the
carrier slice and its stated local boundaries; real launched-worker/Actions/native and
B01–B06/E3 acceptance remain open.

Actual browser Manual readiness/Copy and ordinary same-session Local repeat now have
independent acceptance below. Copy uses the same payload and sessions,
retained native receive objects, successful canonical Close, actual old-target
closure and distinct open receiving targets within unchanged budgets. Its first database
configuration failure and subsequent test-construction failures are retained; none is product
RED or delivery acceptance. The existing healthy canonical Postgres already has all required
migrations; supplying its process environment changes no database or environment file.

The executed Copy fixture now reaches a genuine Manual native receive and observes that
original channel close. Test-first correction of the existing login helper preserves authored
leaveRoomOnClose:false, room membership and both auth sessions. The unchanged test verifies
that correction, then its first copied Local Send still fails RALLAR_BB_RTC_NO_PEERS.
That original copied-delivery attempt remains adverse evidence. Connect returned with no
ready peers; the copied command had no authored readiness. The exact Send-side room snapshot/layout subreason is unobserved,
so this does not establish an enduring SDK or transport defect.

Local JSON and the published Manual source both author canonical rtc.connect.readiness.
Local execution still does not enter Manual's separate Copy history. The real-browser
checkpoint operates the visible editor and retains omitted readiness in previously
submitted history; it reuses the existing bounded readiness contract. No implicit SDK
wait, copied-text edit, new retry, timeout expansion or readiness policy is added.

**Independently accepted browser checkpoint:** Actual Copy/repeat passes one maintained
Postgres case in19.4s with workers1/retries0. It copies complete authored history once,
then runs those unchanged bytes twice with identical payload and auth sessions. Canonical
Close preserves membership/auth and retires the original receive target. Genuine native
callbacks receive the literal payload on targets0/1/2, each open at callback; preceding
targets are closed before each repeated run. Five retained original/attached files are
checksum-bound to the exact executed source. This proves the fixture's fresh channel
delivery, without a universal drain, exactly-once or omission-readiness guarantee.

The existing capture/export/reload/reset case passes one maintained case in14.4s on the
same source. Both original single-browser Connects keep blank readiness; later valid and
malformed raw edits survive reload, preserve submitted history, refuse Connect-producing
actions and clear on Reset. Send/NACK remain independent. Its background403 diagnostics
remain retained; no service-health or performance claim follows. The preceding attempt08
stopped at expected JSON property order after genuine baseline delivery; its original
failure is preserved separately from successful09. Original07 remains unchanged.

Independent SPEC/TDD then separate QUALITY approve the complete browser owner. All49
executed/frozen/current inputs match; all eight published cases and their original
assertions survive. Focused typing, formatting and coupling pass; current-parent
WORKTREE style passes. The test owns actual native references and finalization through
the existing receiver scope, preserving every evidence/cleanup failure. No production,
SDK, CRDT, protocol, policy, environment-file or database change is selected. Worker,
Actions, distributed, B01–B06/E3 acceptance and the original post-ICE cause remain open.

This browser checkpoint is published at `39f68c53`. Fresh original-attempt
[Branch37753289344](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37753289344),
[Formation37753288943](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37753288943)
and [Medium37753288922](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37753288922)
pass. Eight original archives, the canonical validation receipt and18 checkout proofs
bind the published source or its equivalent synthetic merge. Executed selection is
broad with reuse=false. Hosted app results are48 passed/70 skipped, then7 memory
full-stack passes. Native refusal/delivery, Manual capture and Copy/repeat are skipped,
as is RTC integrity. Hosted success adds correctness evidence within those executed
lanes; local native acceptance and the remaining distributed/performance work stay distinct.

**Materializer TDD checkpoint:** Six complete schema-valid manifests use legitimate
room names `off`, `signaling`, `native`, `of`, `gnal` and `ativ`. Actual unchanged
materializer children exit0, emit valid isolated executable scope and preserve source
bytes and hash records, but corrupt all four authored RUN/RECIPE/STEP/HOST capture
literals. Thirty literal/schema assertions fail; omission and five original scope
controls pass. Root and independent SPEC review verify the retained original bytes
and approve correction release. The initial cleanup-hook construction failure remains
separate; passing omission files were cleaned and the reporter suppressed their log
packet, so no retained omission child artifacts are claimed. The original touched test
owner exceeded its navigation backstop and required genuine responsibility consolidation,
checked boundaries and resource ownership alongside the minimum scope correction.
The original RED and construction failure remain retained. The minimum correction now
rewrites only identity fields, canonical state paths and structurally recognized request
identifiers. Independent ordinary-data and suffixless-request cases protect preservation
and accepted request forms. The oversized test is consolidated into five actual capability
owners with checked input/output boundaries and cleanup at acquisition. Obsolete snapshot
source assertions are replaced by a native filesystem failure/replacement/restore witness;
the checked child uses installed dependencies and an empty test-owned cache.
The five capability owners now consume one explicit process-lifecycle owner. Real Vitest
cancellation first failed physical-child retirement and outcome-accounting assertions;
the correction joins both before deleting owned files and preserves timeout/cleanup
failures. The isolated six-owner route passes 104 cases. Fresh final controller/materializer
controls pass 34 cases, and the final process-lifetime controls pass 4; these cover later
changes without claiming another entire 104-case run. The final private fixture-read
naming correction also passes 17 materializer cases. The current 88 maintained disposition
controls pass with zero skips. Format and canonical staged style/coupling pass. Scoped
typing fails only on the unchanged external Temporal dependency mismatch, with no owned
errors or suppression. Independent SPEC review closes the cleanup and boundary findings;
independent complete-owner QUALITY review approves the corrected source without remaining
findings. Original adversity, including the concurrent 5000ms atomic test timeout, remains retained. Hosted tooling uses maintained default concurrency;
local isolated success does not certify its timing.

The next two useful slices are repair of PR633's real conflicts, then HOST/operator RUN
forwarding through the existing workers and Actions. Preserve current main's canonical
audience-routing behavior and the parent capture/admission behavior. Measure integrated
packaging before selecting its minimum allowance, complete changed-owner review and
prepare a fresh exact integration proposal. Do not reuse the old proposal or perform an
unapproved main operation. The earlier adapter audit identified the materializer corruption
now corrected here; controller09 still drops HOST input and general operator adapters still
omit finite RUN selection. Witness those real boundaries before their minimum correction.
Keep canonical precedence, omission and scoped room identity through existing commands
and effects; add no policy/store/harness, migration or retained predecessor path. Publish
each coherent reviewed slice promptly. B01–B06 and E3 remain required outcomes.
The helper's canonical snapshot/auth/artifact boundary closure is now independently approved.
No duplicate permissive contract or compatibility path is retained.

Tests-first fixture checks now reproduce seven resource/failure ownership defects: failed
page creation or navigation leaves an owned context open; borrowed-context setup leaves its
new page open; a partially opened second participant leaks; successor registration failure
leaves its new page open in the shared context; and recipient enqueue/barrier failures leave
unobserved work. Real Chromium objects and existing request ports establish those failures.
Two results-only synthetic fixture failures are separate contract-closure findings. These
are test-fixture defects, not evidence identifying the original RTC stall. The seven
lifecycle regressions and all20 distributed artifact cases now pass in a frozen59-test,
five-file run. The decoder's initial RED was an honestly missing callable capability,
not a reproduced historical malformed-consumer bug. The helper/caller checkpoint uses
canonical contracts and named inputs without compatibility shims. Its focused validation
passes, but independent full-owner review identified four corrections: own result
polling throughout later setup/failure; close the Local Native case's manually owned context
after acquisition, attachment or cleanup failure; use issued auth facts or the genuine narrow
request-auth capability; and remove the fallback for already validated mandatory events.
Six additional actual-port tests reproduce post-barrier lifetime failures before their fix.
The bounded correction first passes all 65 focused checks. Four further originating-error
failures reproduce lost causes during finalization; the final run passes all 71 cases, including
controls for successful cleanup and single-error identity. The genuine Local Native consumer
uses the tested receiver lifecycle owner and passes once on the final source (10.4s test /13.0s
total). Passing buffered observations were not retained by the list reporter; acceptance is
limited to executed assertions and frozen source/command/exit evidence. Scoped re-review closes
recipient observation lifetime, authentic auth capability, mandatory events, context disposal
and preservation of originating and later failures. The original broader gate's 28 records
represent 29 occurrences and 22 exact boundary keys. Complete source review confirms validated
inputs or opaque error observations; no real standards exception is retained. The support
semantic run passes all 88 cases without skips, and the subsequent changed-file gate passes.
The original receiver/result deadlines and warning-and-release policy are preserved.
Root rejects the first private publication projection before staging: it excluded the unfinished
Copy case but also dropped four existing trailing browser cases. The original candidate and
patch remain adverse evidence. The corrected private projection preserves all eight prior cases and their complete bodies
with only the approved login/lifecycle changes, excludes exactly the new Copy case, and passes
focused typing/formatting. Independent complete-file preservation review precedes publication.
Local helper acceptance does not complete Copy/repeat, live-worker, Actions, distributed or E3
acceptance. Publish each coherent tested/reviewed checkpoint promptly.

The bounded worker/Actions audit identified three concrete gaps: controller09 drops the HOST env
input; general Actions/helpers expose no finite operator RUN override; and generic room
rewriting corrupts authored capture modes. Its initial pure scope-owner probe was insufficient
for materializer acceptance; the six current full-valid-manifest RED cases above now witness
that actual boundary, and its correction now has the focused evidence above. Worker
forwarding/application remains unaccepted. The next adapter
proposal keeps HOST in the existing env/Actions variables and adds one optional RUN input
to distributed and GitHub-Free workflows, preserving the lifecycle workflow's25 inputs.
The existing materializer's plain-Node entry must call the canonical finite validator through
an executable supported route before operator admission is accepted. Real default headless
SDK acceptance also needs the existing headless application served alongside API/control.
Preserve the canonical mode parser/precedence and full scoped room identity; add no migration,
legacy path, duplicate policy, configuration store or transport/retry change.

The following WS checkpoint is historical evidence for its exact source, followed by the
current parent-integration status and retained diagnostic history.

The published WS corrective checkpoint is `9d683b3ba00cc0a450a8a940ecdd2eab4c55bbed`, tree
`061cd4d527f7c642b0f9c75f34607294bc81c081`. The bounded WS observer-fixture correction has
independent SPEC and QUALITY acceptance. Fresh [Branch Release Gate37557532249](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37557532249)
passes its selected correctness gates, with13638 passing unit tests and12 skips; the eleven
WS observer cases pass. CodeQL also passes. RTC observation integrity is skipped, so this
release does not supply E3 performance acceptance. The later same-head release37558882828
uses trusted validation reuse and is not a fresh broad test run.

Fresh [formation37557531819](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37557531819)
and [medium37557532587](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37557532587)
pass. Independent correlation verifies their actual checkout as the synthetic merge of
base`e366f60ebf8ad5ee39165793d6decbe3da911418` and head9d, with the checkpoint's exact tree.
All29 recipe reports pass with no blocking failures or skipped recipes. Across12303 executed
results,12167 succeed and136 explicit nonblocking failure rows remain retained; nested
Wait/Set/Parallel rows overlap and are not136 independent incidents. Bounded result/event
views disclose omitted successful history. These are correctness gates, not B01–B06
performance cohorts or full diagnostic-receipt acceptance.

[PR633](https://github.com/intact-software-systems/ar-eye-hunter/pull/633) is open and
MERGEABLE with native review required. Its two real conflicts against main
`94e72f4828e9db5111dc06e4746f1ce09f68ead2` have been repaired, independently reviewed,
validated and published in feature merge `979edba87020bb9e97c9130218c2d3d4020a0aeb`, tree
`f5c9cf3805051f8392306cb5eef34537cf9000ff`. Fresh actual checkout/artifact/receipt evidence
accepts its correctness gates. The exact administrator squash proposal against this
main/head/tree remains pending explicit human approval. No conflict repair, branch refresh,
main commit/push or E3 fallback run is currently selected. PR645 intentionally stacks on the
parent feature branch; the delivery helper's STOP_WRONG_BASE reflects that stack and does
not authorize retargeting or a default-branch operation. Full Task65 remains active.
Task61 and Task62 are locally accepted in the separate
continuation worktree, preserving the proposed integration source. The human-approved
required-input/default-composition/client-clock correction adapts verified callers directly,
with no migration path or retained predecessor. Two scoped review rounds close the admission
and ownership findings. The final affected checks pass642 tests and318 controller cases;
maintained typing covers1,478 files with zero errors. One canonical Either policy handles
nonthrowing admission and strict execution. No named function exceeds60 lines. The five
nonzero changed-style diagnostics were independently assessed against current standards;
SPEC/QUALITY PASS does not treat checker tolerance as a waiver.

Task63 RED now proves that storage drops an actual SDK applied-Off receipt after successful
serialized admission. The full SDK fixture has one semantic failure and48 passing controls.
Eleven invalid serialized completions are accepted and mutate completion state; five valid,
ordinary-failure, replay and cancellation controls pass. Production was unchanged at the RED
freeze. Root verified source and raw evidence, then released the same implementer for finite
canonical admission/preservation, restore, real disk and export validation. The completed source audit
is refreshed after acceptance: known queued-load acknowledgments and matching replay flags
are now enforced. Task64 tests whether accepted caller mutation, pre-start replacement,
cache reassignment or root/recipe capture intent lost across reload can still cause wrong
execution or skip new work. Task64 now witnesses these failures through actual SDK/control
consumers, with valid controls and unchanged production. Historical retired replay remains
truthful recorded evidence; no new liveness/freshness requirement or ICE cause is proved.
Before review fixes, covering native checks passed164 cases and five shared/browser/artifact owners passed102. The current fix passes144 focused native,86 shared and51 actual-SDK cases. Separate same-SDK producer/native-consumer checks
pass and preserve the four original receipts across real disk and exported forms. The frozen handoff is complete;
independent Task63 review found duplicate loop-position acceptance and valid nested loaded-body refusal. The same implementer completed semantic RED/GREEN and the original reviewer approved both corrections with no remaining findings. Task63 is locally accepted. Tasks61–63 and initial Task64 are published at
`b8aa39aaeee7b779a985bd9ad29906ba43a9e421` in draft PR645, followed by plan update
`06559cc4aae1940cd6f0868b87577a898d9f3b41`. The accepted round1 correction is published as
its next coherent slice; exact main integration approval and governed E3 acceptance
remain open.

The original [a3 Branch Release Gate37554289179](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37554289179)
failed eleven WS observer tests with13627 passing tests and12 skips. Its original failed log,
formation/medium artifacts and all earlier adverse checkpoints remain preserved; later
successful correctness evidence does not replace those attempts.

In the original a3 hosted source, the common observer-test packet has `id.v:2`, while the canonical envelope is
version3. Public WS ingress returns `unsupported` before admission or callback dispatch;
all eleven downstream empty-event/time-out failures share that early return. Strengthened
public admission assertions reproduce11 semantic failures immediately with the old fixture.
A typed `ALMessage` stamped with the canonical current-version constant then passes11 cases;
80 resource-limit, WS ingress and owned dispatch-observation controls also pass. This is a
bounded test-fixture correction, with no production, CRDT, retry, timeout or protocol fallback
change indicated. Independent full-file SPEC and QUALITY review passes. The correction is
published at9d and its fresh hosted correctness is accepted; the approved configuration
amendment and governed performance acceptance remain required.
The original failed job log and earlier adverse checkpoints remain preserved.

Fresh local Native correctness at a3 passes1 case/zero retries in48.04 seconds. Independent
correlation verifies all six explicit Native requests, applied receipts and matching scope
initialization before Connect completion; coverage is partial. macOS/Node26 differs from the
hosted performance environment. Twelve original channel-error observations follow deliberate
peer retirement, with temporal rather than causal association; the summary/raw92-versus102
result difference is unresolved. This proves neither full retention nor the initial post-ICE
trigger. E3 remains zero accepted cohorts.

At the earlier frozen7c3 checkpoint, whole-PR current-body and diff coverage is complete
across257 changed paths:77 product,127 invocation/UI and53 measurement/support. Its terminal
cross-domain review returns SPEC and
QUALITY CHANGES REQUIRED, affected legacy/duplication closure incomplete and ready-for-main
NO at frozen7c3. The six confirmed findings below still block that candidate; the HTTP,
startup and B06 findings are separately closed only at their independently accepted local correction bytes.
The review confirms
two corrections in touched code: startup drops `rtcCaptureContext` before room/people refresh,
so run-level Off plus step-level Native can connect Off and then incorrectly request Native;
HTTP implicit auth is selected from the presence of `path`, although absolute/network paths
and an overriding `url` can resolve outside the configured API. Synthetic fake-fetch controls
reproduce automatic bearer/client-ID attachment to foreign destinations without a real
request. Root independently witnesses8 semantic failures/25 passing controls before the
minimum HTTP source correction. GREEN passes33 focused cases plus14 immediate HTTP/auth
controls; package typing, maintained1476-file typing and affected gates pass. Independent
scoped review returns SPEC PASS, QUALITY PASS and full affected-file closure. Root accepts
the exact local correction bytes; they are not in the published7c3 checkpoint and publication
remains held for the corrective batch. Startup forwarding now has root-witnessed semantic
RED (3 failures /8 passing controls), followed by minimum GREEN with the exact witnessed
test bytes unchanged (11 startup cases and71 immediate capture controls pass). Typing and
affected gates pass; root independently verifies protected source, indexes and2511 prior
artifacts. Independent startup SPEC and QUALITY review and full affected-file closure pass;
root accepts these exact local source/test bytes. This is local correctness
evidence, not published-source or E3 acceptance.

The configured-API CRDT admission branch discards Connect completion before starting live
effects. The SDK can truthfully return successful Connect with unavailable capture
application; the actual configured-API outcome has not yet been reproduced, so this remains
a source-supported review concern. B06's reusable gate is now confirmed to accept anonymous
receipts and invalid transport/missing existing producer fields; the actual acceptance test
persists anonymous evidence for all three modes. Current inputs provide no independently
expected controller identities, so no replay or complete-participant proof is inferred.
The emitted-schema correction now has independently witnessed semantic RED: the real
external-attempt service accepts and writes all27 malformed/inconsistent records, while34
valid-record/admission/failure-accounting controls pass. The complete emitted fixture inputs
first pass29 controls; current test bytes pass benchmark and maintained1476-file typing.
Root's actual focused witness retains original failures and verifies both worktrees, indexes,
accepted HTTP/startup bytes and16692 prior artifacts. Minimum pure-validator GREEN is terminal:
61 focused cases,54 canonical configuration/intent controls and32 public API/bundle-boundary
controls pass (147 total). Benchmark, browser, maintained1476-file and Deno typing pass,
alongside affected format/style/structure checks. The witnessed test bytes remain unchanged;
the existing configuration decoder is exported in place without a new public barrel. Root
independently verifies both worktrees and indexes, the four accepted HTTP/startup paths,
16731 prior artifacts and all32 new GREEN artifacts. The first root audit falsely reports
source mismatches because it compares a digest with the entire identity object; the retained
corrected audit compares its hash field and passes. Independent SPEC then QUALITY/full-file
correction review passes at the exact terminal bytes; root fully reads and accepts that
bounded correction report. Publication remains pending. Complete invocation/UI
review also identifies two inert history-fixture guards and an unused workflow mock inside
touched files. Root verifies the source and named consumers; no product regression is claimed.
Measurement review also confirms three duplicate browser disposition records and a stale
disposition plus its coupled fixture for a deleted benchmark owner. Root verifies these exact
source facts. Remove duplicate and obsolete policy records together with the retired-owner
fixture; a passing coupled test does not justify retained dead policy. Invocation review's
ten requested registry-to-effect associations pass within their explicit assertion limits.
The fixture correction is now independently accepted at its frozen fifteen-owner bytes:
87 semantic cases across sixteen consumers pass, including the eleven construction/history
controls. The two message tests use complete public composition; five obsolete private
inventories are retired. Both earlier adverse reviews remain preserved. Current policy
has independently witnessed semantic RED: the unchecked-cast classifier denial fails while
87 controls pass. The first specimen-owner failure is preserved as a setup mistake rather
than RED. Minimum GREEN is frozen in the three existing policy owners:154 focused cases,
maintained1478-file typing with zero errors, formatting and real inventory/backstop checks
pass. Independent full-three-file review is approved and root has accepted its frozen bytes.
The correct-e366 changed-style gate passes with no new findings. Structure passes with18
review observations; the default full scan reports3441 nonblocking observations. Those
exits do not replace human closure or approve E3. Checker algorithms and unrelated
consumers remain outside the correction. The affected policy findings are closed, and final
corrective code review confirms SPEC PASS and architecture APPROVED. All18 structure observations
have concrete human keep/navigation judgments. Scoped prose review passes and the batch is
published at a3b1662df. Its new WS fixture failure is diagnosed above; the bounded correction
passes independent SPEC/QUALITY review. Reviewed publication and fresh hosted/main acceptance
remain required.
None authorizes speculative changes or the independently held CRDT
acquired-send/encrypted-output successor. The original post-ICE trigger stays UNKNOWN.
At the earlier current-main conflict checkpoint, delivery status required REPAIR_CONFLICT.
The live main ref was
`e366f60ebf8ad5ee39165793d6decbe3da911418`, adding the independently published ALM membership
fencing change. Its actual Git merge with published7c3 has five conflicts: the browser message
sender, messages controller, bundle budgets, sender test and server receipt-row test.
The previously displayed97f6686 base still merges cleanly to the old7c3 tree, but it is not
the live main source. Preserve all seven approved local correction files and held original
work while reconciling current-main fencing with reviewed RTC capture/admission. No
broader final validation or publication proceeds before this real source conflict is repaired.
The seven independently approved HTTP/startup/B06 files are preserved in local checkpoint
`0ea0f964f529013bb4a66336946796f90d792102`, tree
`d504fc56f247361287d54ec6dc95563817c5a35b`, parent7c3. It is unpushed. Root verifies all
source bodies and16791 prior plus36 additional artifacts remain unchanged through that
checkpoint. Readonly preparation identifies two dependent fixture owners beyond the five
markers: the current-main shared facade initializer needs the canonical capture receipt;
the PR's extracted server receipt fixture still emits v2 while main requires v3. Initial
reconciliation resolves the five markers and exercises existing focused semantic controls;
the initial marker-free candidate is staged at7d547444bb00145730a2988fd30eaf053edf91f5.
Actor and independent root runs both produce3 semantic receipt-admission failures/96 passing
controls. Source correlation identifies the unchanged extracted v2 message against main's
strict v3 contract; no detailed rejection code is inferred from those assertion logs.
All21 shared-facade sender cases pass. Maintained1478-file typing independently fails with
exactly one error in each identified support: the missing mandatory capture receipt and
literal2 where3 is required. Detailed TS2322 diagnostics verify both causes; compiler-only
contract reconciliation is qualified separately from the three semantic failures. Root's
before/after witness proof verifies6086 candidate files,6049 original tracked files,20127
immutable artifacts, both Git/index identities, all seven checkpoint corrections and held
three successors unchanged. Minimum GREEN corrects only the two current fixture owners;
full-file closure also replaces two production-derived expected values with independent
literals. Those assertion-only corrections are qualified separately from semantic TDD,
and all original witnessed bytes and raw results remain retained. No artificial parser,
import or type-only failure establishes semantic RED.

The sole implementer is terminal/stopped at actual working-source tree
`617062ab318ce737dcd25f0fe37a5f92ae1ecd57`, bound through a private index while the real
index still retains the initial7d staged candidate. The six-file command passes99 cases,
actual facade consumers42, public API/bundle boundaries32, earlier checkpoint controls105
and real isolated PostgreSQL worker handoff1. The final receipt-row assertion correction
earns only its four-case rerun and final scoped checks. Package and maintained1478-file
typing pass with zero debt/errors. Actual composed facade248.5 KiB passes the unchanged
249 KiB ceiling. Root fully reads the terminal report and manual delta, independently
verifies6086 current files,6049 original tracked files, exact checkpoint7/held3,20136 prior
immutable artifacts and62 new GREEN artifacts, and confirms the six raw passing summaries.
Independent SPEC and QUALITY/full seven-file standards and preservation review pass at
these exact frozen bytes, with no findings. Root fully reads and accepts the complete
independent review. The exact tree is preserved in clean local merge checkpoint
`12197c382c74e37a09413b75413377cf01e2c961`, parents0ea/e366. Only the four final correction
paths are newly staged over Git's existing composed index; staged and committed tree both
match617062ab. Root's post-checkpoint proof verifies6086 current files,6049 original tracked
files,checkpoint7/held3,20203 prior immutable artifacts and five checkpoint artifacts.
Original held work and its index remain unchanged. No remote publication or default-branch
operation occurred.

The broad changed-style command genuinely exits1 on composed
`scripts/repo-style-check/reviewed-dispositions.mjs`: scanner1227 lines exceeds the1200
navigation backstop. Incoming main has930 splitlines, published/checkpoint1113 and
composed source1226; the threshold crossing comes from combining both branches. The
command precedes the final assertion edit, so it is not final-byte delivery validation.
That owner is already queued for policy closure; the failed check and seven automatic
structure prompts remain explicit. Correctly based final delivery validation is still
required. The merge checkpoint is local on `codex/rtc-baseline-integrated`; publication,
default-branch integration and E3 remain pending. The next fixture six-file scope and
sixteen actual consumers are rechecked against the composed source and remain unchanged.
The two current history consumers produce an actual semantic TEST-ONLY RED: both cold
public Connect calls resolve despite a literal injected construction Error, while all nine
original controls, including five cold history reads, pass. Root independently runs the
exact frozen tests and witnesses the same2 FAIL/9 PASS with source, index and prior
evidence preserved. Minimum canonical fixture GREEN now passes all11 focused cases and
92 cases across the16 actual fixture consumers; maintained typing enforces1478 test files
with zero debt/errors. Independent review confirms SPEC PASS but QUALITY/full-file
NEEDS FIXES: three in-memory getters, three mock-setting helper names and four named
import layouts violate current touched-file rules. The first bounded fix is terminal across
fifteen files, including nine verified additional consumers. Final formatted bytes pass
all11 focused cases, the same92 direct-consumer cases, maintained1478-file typing and
affected formatting/style/structure checks. Root verifies the mechanical delta and
preservation. Scoped review accepts all previous findings and confirms SPEC PASS, but
full-file review of the nine newly affected consumers finds two invalid mandatory
dependency constructions and five obsolete private-export inventories. The second bounded
fix is now terminal in six existing test files: actual public composition preserves the
literal message/storage expectations, and only the private inventories retire. The same
sixteen consumer suites pass87 cases, including the unchanged11 construction/history
controls; five obsolete inventories explain the count reduction. Typing and affected
gates pass. Root verifies the delta, literal expectations and preserved evidence. Scoped
independent re-review is complete: SPEC PASS and full-file QUALITY APPROVED across all fifteen
owners. Test-maintenance corrections need no fabricated RED.
This is fixture integrity debt, not a demonstrated product history regression. The completed
current-policy correction removes duplicate3/deleted1 records and nine unsupported debt
exemptions while preserving the genuinely narrowing predicate. Root independently witnesses
actual classifier-denial RED,1 FAIL/87 PASS; minimum GREEN passes154 cases and maintained1478-file
typing with zero errors. The bounded canonical cleanup clears the1227-line backstop without a
split or checker relaxation, and independent full-three-file SPEC/QUALITY review approves.
Final corrective code review accepts the composed source and all18 structural dispositions.
Only this review's current-status prose correction remains before corrected-source publication.
E3 has zero accepted cohorts and no current producer. After corrected-source review and
hosted acceptance support integration, select the reviewed exact main snapshot and run the
existing3+11 primary with its controller-selected repeat and original failure accounting.
The primary contains one warmup for each of default, all-scenarios and retention, then
5/3/3 retained attempts respectively. The100-cycle workload applies to the retention case.
The selected repeat retains10/6/6 attempts with the same three warmups; it runs only after
a passing primary when the existing controller selects RTC-B06.

**Retained historical checkpoints:** The paragraphs below preserve the evidence and
decisions leading to the current7c3 checkpoint; they do not supersede the latest status
above. At the earlier October6 checkpoint, PR #633 remains draft, OPEN and MERGEABLE after the reviewed
source-conflict repair is published as
`b03021514c0339e6fe37aa32f2ad167d00653369`. The initial Task58 checkpoint remains
`431a77b93ccae63d7ca7ad8869838086e1201967`. The separate feature checkout preserves
the original independently held work. The reviewed Native/Manual/Join source checkpoint is
`bd1a03f774521d3cfd911347878eef12831f84ab`, with SPEC PASS and QUALITY APPROVED across
all33 full touched files; combined-source runtime acceptance remains separate. The current
published runtime checkpoint is `bef74e282e224f32334fd033e2ba103184762d51`, which includes the
independently approved capture-selection/admission and presence-lease recipe corrections.
Root's combined affected check records43 files /533 PASS, with Deno CLI and current-file
format checks passing. The actual zero-retry Native browser preflight on that clean
published source passes one matrix case in50.532 seconds. Independent recorder correlation
finds six applied Native Connect receipts, each with one matching agent/session/scope
initialization before its Connect result; Native availability is enabled and coverage partial.
The source stays unchanged and the harness ports are clear afterward. This proves local
correctness and acquisition at Connect completion, not E3 performance or final scope activity.
Fresh hosted status at this head passes the main unit suite but fails one tooling workflow
assertion: its old exact dispatch-input shape excludes the approved `rtc_capture_mode` choice.
That suite records1 FAIL /1497 PASS. The hosted run is now terminal: both API standard
shards, both Recipe Console shards, cluster, Postgres integration, formation-large and
medium-scale succeed. The exact corrected presence-lease recipe reports23 successful
operations, zero failures and exit0 on the Postgres shard; all30 selected recipes pass.
Static checks additionally report six missing individual test-boundary classifications
in the existing browser soak test. The initial controller summary showed only three; complete hosted and exact local
logs agree on all six. The same bounded subagent correction covers those concrete
candidates, without weakening the checker or blanket-waiving interactions.
The support correction is terminal locally:16 workflow tests and the unchanged12 browser
resource/admission controls pass, maintained typing enforces1476 test files with zero errors,
and current registry/style/structure/format/diff checks pass. It changes only the workflow
contract test and canonical six-entry registry, with production/checker bytes unchanged.
Root verifies the frozen files, prior282 contracts/429 entries and source/evidence/index
preservation. Independent review returns SPEC PASS and approves all six individual
interaction classifications. Its two Low clarity findings are corrected by the same
implementer: remove an unused fixture local and check the missing job before its steps.
Scoped re-review returns SPEC PASS and QUALITY PASS. Final16 direct/shell tests pass,
maintained1476-file typing reports zero errors, and complete changed-file style reports
zero findings. The workflow test's final SHA256 is
`9afd86329b517231609e58543232e1accd6239e03fded7a80ed3124b6cdd78b3`; the approved registry
remains `0a9e94c2140c67fcd6653407264412fbb86d209d45358a0257037cabdb975942`.
Root independently verifies the exact two clarity edits and preservation of6075 untouched
target paths,6048 original source/test paths,167 historical evidence files,26 previous
correction artifacts, both HEADs and both raw indices. This support checkpoint is approved
for publication and is now published at7c3e2478 with the fresh normal hosted gates above
accepted. Whole-PR review remains required. The failed bef74 attempt stays retained. No hosted rerun or E3 producer
was started, and no new production, workflow, browser, retry or timeout change is included.
The previous plan-only head was `7adaef7d21547fbfe8fddd901ce341254ec97af5`.
[Release Gate37498708746](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37498708746),
attempt1 at that exact head, fails the unit suite and API standard2/2 shard. The unit
failure is the unchanged benchmark architecture guard rejecting two package-test imports
of `RtcBaselineJson`; preserve that boundary and use the existing product JSON contract.
The API shard passes29 recipes and fails the presence-lease lifecycle recipe: expiry is
recorded and only Alice remains, but presenceRevision stays2 against the final strict
increase assertion. Immutable-source diagnosis traces separate expiry-event publication
and summary convergence: the recipe does one GET immediately after seeing the event,
accepts already-correct liveness counts, then prematurely requires the later summary revision.
The log contains no subsequent observation proving convergence or a worker failure.
The recipe correction earns real-runner late-convergence RED, followed by13 semantic
controls and62 combined focused cases passing. A second witnessed RED catches acceptance
of a Bob-only active session or a disconnected Alice; direct identity/status predicates
close it. Event visibility, fresh state and the strict assertion now share the original
60-attempt/95-second bound. Permanent nonconvergence remains a recorded failure and blocks
the fresh lease. Maintained typing enforces1476 files with zero errors. Independent SPEC
and QUALITY review approves both complete files; fresh hosted acceptance remains required.
Do not relax strict increase or expand
timeout/retry policy. These gates are not accepted,
and E3 remains unexecuted. At the
original source, Manual selection passes39 unit cases, and the
Connect-to-Join forwarding repair passes154 affected cases and independent
specification and quality reviews. The actual browser now proves applied Off and Full native,
including enabled native coverage, after provisioning its real group precondition.
Its newly reached retained-export matcher initially rejected the legitimate sessionId
despite preserved Off/native commands. The test-only nested partial-matcher correction
retains both mode assertions. The final real-browser run is2 PASS, exit0: actual
applied receipts, desired/current separation, recorded export, reload and Reset all
execute successfully. Scoped independent specification and quality reviews are approved.
The sole final quality correction separates the browser test's workspace import; inverse
header reconstruction restores its exact passing bytes, without changing any assertion.
Task58's independent encrypted-output typing decision remains held for explicit
maintainer approval; its resource-disposal correction is reviewed.

E3 has zero accepted cohorts and no current run. The latest inspected B06 diagnostic,
[37222104427](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37222104427),
failed all three diagnostic runners on62f067706; this is newer than the historical
archive inventory below and is diagnostic evidence only. An unchanged431a77 run still
uses product-default Signaling: its B06 runtime configuration omits capture selection.
The original minimum correction passes40 focused cases after23 witnessed failures,
with1465 maintained test files enforcing zero first-party type errors. Fresh independent
specification and quality reviews approve that bounded correction. The final import-only
closure preserves the exact reviewed runtime/test bodies and historical40-case evidence.
Finite process-environment selection now passes17 cases and61 affected controls; its28
frozen source/guard/artifact hashes match. Specification and quality reviews approve after
the body-preserving environment-reader rename; its50 historical/correction identities match.
The receipt-retention/native-preflight checkpoint has16 witnessed semantic failures
with all40 existing controls passing. Root verifies64 evidence identities, exact original-test
reconstruction and eight unchanged source guards; maintained types enforce1465 files with
zero debt/errors. Two additional strict-acquisition assertions raise the current RED to18
failures/40 passing controls across58 cases; root witnesses both actual failures and verifies
13 new source/artifact identities with the original checkpoint unchanged. GREEN initially
passes58 cases. Review catches session extraction preceding receipt admission; one additional
witnessed RED fails while58 controls pass, then the correction restores admission first.
The final five affected suites pass121 cases, including59 formation/delivery cases.
Maintained/native types, format and whitespace pass; root verifies50 current checkpoint
identities and64 preservation identities. Independent specification review finds one required
failure-path gap: a synchronous acquisition invocation throws before the installed promise
catch, losing its admitted Connect record. Its independent probe reproduces that loss while
the async rejection control retains the record. A focused regression witnesses one failure
with59 controls passing; the direct invocation/await catch correction then passes all60
focused cases. Fresh maintained types, format and whitespace pass; root verifies20 correction
identities. SPEC re-review approves the correction. Initial QUALITY review finds one
boundary-free readiness forwarding method and otherwise accepts the five-owner behavior
and cohesion. The public method now owns the unchanged private async body; root verifies
20 correction identities and exact full-file inverse. All101 affected cases pass, including
the60 retention cases; maintained1465-file typing, format and whitespace pass. Scoped SPEC
preservation and QUALITY re-review approve the correction and complete five-owner closure.
The next slice's actual test-only memory-browser RED is witnessed: zero retries, one failure,
exit1 after25.524seconds, expected3 returned captures versus0 after the realtime matrix.
Three recorded successful Connect receipts confirm applied Signaling/product-default despite
process Native selection. Producer guards and matrix are unchanged; fresh services tear down.
Concrete reader/matrix/output implementation now passes204 cases across five affected
suites; maintained1465-file typing, format and whitespace pass. A root-serialized actual
Native browser run then fails once, exit1/18.042seconds, during initial-pair room refresh.
Its recorder proves two applied Native/step Connect receipts and matching initialized
active scopes. The failure is explicit: product room composition calls explicit Connect
without capture intent, resolving product-default Signaling against the owned Native
connection and triggering new-connection-required. This is a newly identified acquisition
integration defect, not the historical post-ICE trigger. The product correction witnesses
8 failures/3 passing controls before78 affected cases pass. Nested capture consumption
additionally witnesses36 failures/12 passes before the combined190-case GREEN; shared-web
and maintained1466-file typing pass. Root reruns the final11 product cases successfully.
The next isolated browser run fails once, exit1/17.491seconds, at the black-box topology
hydration helper's second implicit session.connect call. Its real owned Native runtime
regression witnesses1 FAIL/4 original passing controls, then all66 affected cases pass.
Shared-test typing and maintained1466-file typing pass. The corrected isolated browser
passes1/1, exit0/50.020seconds, with zero retries, six applied Native/step Connect receipts
and six matching initialized active scopes. Services stop and all source hashes are
unchanged. Fresh whole-slice SPEC review approves all17 current owners and closes the nested
capture finding. The integrated33-owner QUALITY review approves the combined source. The
separate CLI/workflow/configuration implementation and review correction are now approved;
combined-source browser/cohort and hosted acceptance remain pending.
The earlier
121-case/native-compilation evidence retains its historical source attribution.
The subsequent GitHub delivery check reported PR633 CONFLICTING and REPAIR_CONFLICT.
Read-only merge analysis against fetched main97f6686cf708114b4c8dc78f7d796ec5e3790998
identified seven content conflicts: browser communication composition, middleware
initialization, message controller, both browser/headless bundle budgets, AL inbound
delivery and the WS queue service. That real conflict required repair before broad validation
or publication, preserving all unpublished and independently held work. The original local
browser result remains attributed to its frozen source, not the combined source.
The separate repair checkout now reconciles all seven working-file conflicts, preserving
147 automatic paths and both branch capture/clock/cleanup and upstream resync requirements.
Eight mandatory callback bindings remediate the reached capture-reuse fixtures. Final187
focused cases, affected package typing and maintained1474-file typing pass. Both parents
fit their own bundle caps; the combined source measures248.249/318.056KiB and initially
fails the branch247/317 caps. The explicitly selected integration budgets are249/319KiB,
the smallest whole-KiB caps above those measured outputs, with769/967bytes headroom.
Browser budget, headless boundary and all32 public controls then pass; emitted bytes and
hashes remain identical, with historical failures retained. This is a packaging-policy
adjustment for the combined features, not a runtime optimization or E3 threshold change.
Independent SPEC and QUALITY reviews approve the current eight-owner reconciliation.
The two quality import-layout findings are corrected; exact inverses preserve all body
and oracle bytes. Root's
automatic-tree comparison verifies all147 automatic path blobs unchanged, with
differences limited to the seven conflict owners and the required fixture. The index
has zero unmerged paths. The repair is committed and non-forced published to PR633;
GitHub reports MERGEABLE and delivery reports WORK. The temporary feature checkout's
local name does not resolve that PR through the delivery helper, so root queries the
existing source branch and verifies the actual remote head separately; no duplicate PR
is created. The frozen33-owner Native/Manual/Join patch is now integrated by its published
base, committed as `bd1a03f774521d3cfd911347878eef12831f84ab`, with exact reviewed tree
`c4104f213f625276c2bf8815e5714070167cf6a6`.
The current focused suites pass309 affected cases,50 acquisition/cleanup controls,60
retention cases and33 API/boundary cases. Package/app types and build,1475 maintained test
files, formatting, changed-style, structure and legacy review pass with recorded warning
dispositions. Browser/headless outputs fit the unchanged249/319KiB caps. The two mechanical
reconciliations supply an upstream mandatory fixture port and normalize rejected values at
the retained-failure boundary. Fresh independent review reports SPEC PASS and QUALITY
APPROVED over all33 full touched files, including every inherited test body. No combined-source browser or
performance acceptance follows. The two held CRDT source changes and six coupled acquired
cases remain preserved in the original checkout and excluded from this integration;
root independently verifies the other39 original guards and the original index unchanged.
Four configuration test-only RED owners remain frozen for the next slice. The full goal
is active. E3 is planned after integration and configuration acceptance,
using the original3+11 primary and only the existing controller-required repeat.
The B06 observation controller still lacks sealed capture selection for the missing
native transport/generation evidence. Prioritize explicit B06 selection and actual receipt
preflight before another cause-finding diagnostic; preserve the accepted sample,
source, environment and cohort gates for subsequent performance capture. GitHub reports the
published b030215 repair's normal release, formation-large and medium gates SUCCESS, with RTC
observation integrity SKIPPED; this does not certify the newer Native/Manual source or E3.

The earlier audited main snapshot is `c727caad561347a151a426579cf0d598e39f8ac4`.
Task 23 integrated fetched upstream
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1` into the reviewed feature source
`80fa09acf5f9cc641d6ab67ff373f36d1296d924` after a real PR merge conflict.
The published merge is `13b59557121ae8b8bc2b1d8dccccd54927afbc61`, tree
`d5451616ce7aee445430d0da22c9dfaf31b8cdbc`, with those exact two parents.
Those 13b independent review, publication, normal CI, medium-scale/fairness and
full-PR state-write passes remain source-attributed historical evidence.
Task 27 and both fixes are independently reviewed and published at diagnostic source
`93fc50196e9cb6f4e345a39fca3b82876240d4a9`, tree
`24a259fe0873b7092f346f6b5081de50da4c2276`. Required exact-source native workflows
and the narrow medium/supported semantic correctness gates passed. Task 28's
unchanged diagnostic proof is complete only at its exercised observation/usefulness
scope: producer FAILURE, captured formation evidence useful, native cause
UNCLASSIFIED and zero accepted performance cohorts. Task 25's earlier proof
retains its own source and limits. Task 29 completed reviewed factual reconciliation
and feature publication at `21fd11987cb9fac818c766b63a3ee72db79a0204`, tree
`fae860e6ebf1840ee15f4ade1ccaa8464b759f14`; only plan prose differs from 93fc.
Tasks 30 and 31 are complete at their accepted read-only scopes below.
Task 32's factual reconciliation was independently reviewed and published at
`e89a57b85e415450291cc376778d31418435b6eb`. Task 33 is complete at its narrow
ownership/approved-clock correction, recursive changed-file/support closure,
independent review, local validation, publication and required hosted-correctness
scope on `c3b3d34651129ba170a57a7453f1453365294056`, tree
`b8d0d335f655f9fccb2e8655daae1f99106a53bc`. PR #633 remains draft, OPEN and
MERGEABLE. Task 34's one unchanged diagnostic and retained finite review are
complete at their bounded exercise/usefulness scope: producer FAILURE, useful
later health, incomplete history and zero accepted cohorts. Neither scope
establishes a historical diagnostic cause or accepted E3 performance cohorts.
Task 35's minimum existing-owner signaling observations are independently reviewed,
published at `62f067706f46a6f7a1d4b4f9ac6987ae31244ea5`, and accepted through the
required Branch Release, formation, medium/fairness and supported-distributed
correctness gates. Service routing, native decisions/operation returns and the
first accepted caller release remain distinct facts. Their optional complete
sink/clock capability uses the already approved clock and preserves the existing
public result, Promise scheduling, policies and native lifetime guards. Optional
ALM failed only at the inspected receiver-boolean scope; cause and raw-artifact
association remain unverified. c3b3's earlier evidence retains its own source.
Task 36's one changed-source diagnostic is terminal FAILURE. All three runner
uploads succeeded; 88 unchanged originals / 5,980,973 inner bytes are verified.
Actual participation is 10 PASS / five FAIL / 12 selector SKIP across 27 slots;
retention first failed at recorded cycles 7/3/1. The independently reviewed
18-test finite reader executed once per runner and retained 175 safe rows,
including 134 of 148 valid Offer/Answer decisions with 14 explicit tail omissions.
Three caller retirements and one current-PC Answer rejection with offer mismatch
are recorded observations, not a causal diagnosis. Bound later health and
incomplete history remain distinct from the still-unclassified failed phase.
No additional producer, accepted primary/repeat, or historical cause follows.
Task 37's independently reviewed local Chromium profile measures the existing
diagnostic event pipeline at docs-only source `d97131dc1`; all 15 relevant owners
are byte-equal to 62f067706. Sixty fresh-fixture samples and four separate sampled
CPU passes preserve exact event/transport effects. At seed histories 0/1,000/10,000,
the median 500-event control-client burst costs 13.8/19.8/106.3 ms; retained-history
scanning dominates sampled control CPU. Actual headless DOM bursts cost
32.2/39.9/132.0 ms. These are local observation costs, with no network or native
RTC work, historical failure explanation, accepted E3 metrics or optimization.
Task 38 independently reviewed the canonical finite failed-step reader and executed
it once per runner on only the three retained retention logs / 48,250 bytes. All
three rows remain unclassified: each retained failure header omits the unique
errored-step suffix. All 88 originals and three archives remain byte-unchanged.
A source-authentic long-header separator defect then earned one meaningful
27-PASS/one-FAIL RED and final 28 PASS; that amendment did not repeat or relabel
original execution. Neither missing step metadata nor supporting printed frames
can establish the original failed operation or a native cause.
Task 39's separately reviewed failure-detail amendment preserves the absent step
while exposing finite recorded text. Final 32 synthetic tests passed after genuine
semantic, mixed-class and assertion-label REDs. A new bounded release executed
once per runner on the same three logs: each 271-byte row records a generic Error
and reconnect/canonical-readiness/formation-request frames. The connect frame is
unavailable; it does not prove the call was absent. Operation and cycle remain
unclassified, and no failing predicate, native cause or accepted cohort follows.
Task 40's independently reviewed source trace binds 39 unchanged owners to runtime
62f067706 and recovers refresh, remaining budget, command/result, cancellation and
canonical room-readiness ownership. Short/exhausted-budget harness boundaries
remain candidates for a discriminating regression; no historical cause or native
correction is established. Task 41's existing local memory-mode three-browser,
100-cycle retention diagnostic finished EXIT1 after 634.695s with zero retries
and fresh owned API/SPA/control services: one PASS, one FAIL, one selector SKIP.
Its unique errored step is cycle17 reconnect/readiness; the reported Error message
begins RALLAR_BLACK_BOX_FORMATION_NOT_READY. Two existing captured rejection
observations have held summaries and desired2/ready1 with roomOpen false; the
missing readiness reason and first-result-agent association remain unknown.
The earlier local pipeline
profile did not exercise B06. Local diagnostic evidence is separate from governed
baseline acceptance; E3 still has zero accepted cohorts.
Task 42's source trace and bounded follow-through identify the later current-session
connection between agent ordinals1 and3 as nonopen on both configured lanes;
each remains ready to ordinal2. Retained Offer/Answer returns and peer-timeout
notifications narrow that observation, without identifying a native generation,
captured wait peer or cause. Captured idle can reflect either unavailable current
layout coverage or timeout/abort suppression in the canonical status owner.
The existing projection lacks the captured discriminator; no correctness fix or
new producer is selected from this read-only trace.
Task 43's bounded captured returned reason/lane/peer observations were published
at 3bd05a196. That source's required Branch Release failed seven changed-style
findings despite its separately passed executed runtime lanes and formation/medium
checks. Fix3 repairs the typed normalization boundary without changing captured
facts or readiness policy; retained independent review, local focused/types/style
and affected consumer checks pass. Published Fix3 at 48cb727 has terminal required
Branch Release, formation-large and medium-scale passes. Optional ALM failed with
cause unclassified; RTC observation integrity was skipped. Task 44's one
unchanged-through-run local diagnostic failed at cycle7 peer-C
reconnect/readiness; the numeric npm child exit remains unavailable after the
post-wait wrapper failure. Its limited reads supplied captured timeout/lane/peer
facts, nominal allowance and later status. Task 45 supersedes those limited-read
boundaries with authenticated original command/result and 6,398-row correlations.
A and C time out despite adopted current-presence layout; three matching Answers
complete native application. Retained-peer establishment expiry invalidates later
recovery pairing, without proving the initial post-ICE native/channel failure or authorizing timer
renewal. Actual SPA measurement reproduces approximately 117–150 ms continuation
delay with hidden presentation work versus approximately 4 ms with UI subscribers
off. That observer cost is measured; its sole responsibility for the original
connection failure remains unproven. E3 still has zero accepted cohorts.
The retry proposal is now assessed from current source: synchronous native lane
allocation failure can block the next ensure's repair on a live peer. It is a
separate correctness candidate awaiting semantic RED, not an explanation of the
captured channel-present initial stall. Broader retry or establishment-deadline
renewal is unearned; Task 47 records the implemented observer correction.
Task 47 implements the observer presentation correction at 65b257ab6, followed
by test/support closure at `9db431d2cae002e1867aa9e5149ae603fc7675df`.
Closed reports and inactive trace/event
panels stop retained-history presentation; drafts, filters, disclosure, current
redacted outputs and complete recorder contents remain intact. Semantic RED/GREEN,
app tests/build and real browser workflows pass. Initial independent review
required test-closure fixes; scoped re-review approves the completed correction. No comparable post-fix timing, native-cause conclusion or accepted E3 cohort follows.
Task 48 records terminal hosted rejection on exact source
`ac3f5d95f46ef381d577a23fdee79cfc8f03cfea`: Branch Release run 37282459228
failed its static coupling gate and Recipe Console shard 1/2. The first rejects
an incidental production filename inventory in the touched mode test; the second
still expects the predecessor Runs asset name after its canonical module changed.
The test-consumer correction is committed at
`ab64b7822d4b79e5a534916d60b0b0877b3aa627` with passing local checks and exact
committed-range coupling acceptance. Initial independent task review requires
meaningful active Runs shutdown proof and truthful fixture transition names;
fix1 corrects both at `c62dd5b5cd6ecb5704509eab0dbfa9e8f677788c` with
meaningful fixture RED/GREEN and recursive consumer closure. Scoped independent
re-review approves specification and quality with no actionable residuals.
The correction and refreshed plan are published at
`92a6261a1522b3f40e7171da8f41dd7e369ea0c3`. Fresh Branch Release and its required
aggregate result pass, with every executed lane successful and RTC observation
integrity skipped. Independently audited formation/medium correctness also passes
on a synthetic merge checkout whose tree equals the published feature tree.
Task 48's correctness gate is complete. Task 49's read-only native observation
audit has independent specification/evidence-quality approval and proves missing
lifetime, transport, candidate-association and timeout/deletion provenance.
Task 50's corrected architectural proposal has independent design/specification
and quality approval after four finite corrections. Task 51 records the human-approved
configuration amendment and explicit authorization to implement when the plan is ready.
The complete specification and next-two-slice plan have independent readiness
approval after restoring canonical table fields, typed expected failures and
existing-owner RED ordering. Subagent-driven semantic TDD is authorized. At that
design checkpoint, no capability was implemented yet. Subsequent Tasks52–59 implement
the SDK/native and reviewed recipe/Connect checkpoints and the current Manual work;
remaining recipe UI, distributed, bootstrap/Actions and B06 acceptance stay required.
A configured sink no longer automatically selects native capture: Off, Signaling and
Full native are explicit connection settings through those owners.
No initial-stall cause, retry policy or new performance cohort is accepted.
Tasks 0-7 and observation tooling are delivered. The full baseline remains incomplete:
E1 measurement evidence remains unverified/unrecovered, E3 has no accepted primary, Task 12
is gated, and B07 remains held. A package check proves tooling, not capture.

| Environment / workload | Evidence available at the audit                                                                                                                                                                                    | Acceptance consequence                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1-local / B01-B04     | Issue #267 historically reports `20260818-22bb4919c92f-e1-local` and a required repeat on `22bb4919c92f96d785ff65d7f308a6d2fd3318e7`; bounded recovery did not find envelope bytes, checksums, or the repeat link. | Task 8 remains unverified. Synthetic #274 memory fixtures are not measurement evidence; recover/verify or capture after representative E3 succeeds.                       |
| E2-browser / B05       | 31 ZIP/index pairs (Aug 29-Sep 27), all passed with accepted metrics; 17 need no repeat and 14 required repeats passed.                                                                                            | Task 9 is active. 22 final selected distributions have every metric CV at or below 10%; nine retain noisy `firstOpenDurationMs` after repeat, which remains inconclusive. |
| E3-memory / B06        | 14 ZIP/index pairs (Aug 30-Sep 11), all failed, `acceptedMetrics: false`, no repeat required/run.                                                                                                                  | Valid diagnostic archives; zero accepted E3 primaries or metrics. Partial default successes do not satisfy B06.                                                           |
| E4-pg                  | No capture; existing E3 decisions say not required because no database-backed candidate is selected.                                                                                                               | No database-backed conclusion. Revisit for the exact candidate.                                                                                                           |
| E5-remote / B07        | Held.                                                                                                                                                                                                              | No B07 performance claim; outside default completion unless separately required.                                                                                          |

All 45 checked-in ZIP/index pairs passed the current package-owned
`verify-observation` command. Archive length, SHA-256, and internal observation
records match their canonical rows. This proves recorded artifact integrity,
not that current main reproduces historical results or failed B06 metrics pass.
Select observations explicitly and never pool unlike source/environment facts.
The durable entry points are `performance-observations/rtc-b05/index.jsonl`
and `performance-observations/rtc-b06/index.jsonl`.

PRs [#562](https://github.com/intact-software-systems/ar-eye-hunter/pull/562),
[#563](https://github.com/intact-software-systems/ar-eye-hunter/pull/563), and
[#566](https://github.com/intact-software-systems/ar-eye-hunter/pull/566) are
merged. Sender-failure orchestration already starts bounded receipt observations
before send, settles both sides, and preserves sender/receipt failure precedence.
Required offer identity, retained-peer redial, heartbeat lease renewal,
overlay-gap recovery, cluster signaling, and named retention phase diagnostics
are delivered; none proves that every E3 reconnect now succeeds.

An earlier completed B06 diagnostic,
[36761155884](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/36761155884),
was a pre-#566-merge diagnostic on
`cf8e975045f6beb9a33506b18f7aa9ba4acf9c89`. Runners 1/2/3 failed retention
reconnect readiness at cycles 1/13/5; none reached 100. Capture/publication were
skipped, so this is not an accepted primary. The error establishes failure to
regain formation readiness, not the RTC close/reset/remove issuer or a safe
watchdog fix. Deadline renewal is neither implemented nor authorized by it.

Unchanged main run
[37108696378](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37108696378)
completed capture on `c727caad561347a151a426579cf0d598e39f8ac4` and finalized
**FAILED**, with no accepted metrics and no repeat. Ten earlier default and
all-scenarios attempts passed; the first retention warmup failed formation
reconnect readiness at cycle 8. Retained retention attempts are causal not-runs.
No job budget fired. Publication separately failed with HTTP 401; the canonical
publisher recovered the exact unchanged archive in
[PR #639](https://github.com/intact-software-systems/ar-eye-hunter/pull/639).
This is proposed diagnostic evidence, not an accepted E3 primary or a merged
checked-in corpus increment. Only cycle-0 RTC diagnostics survived: teardown
preceded failure capture, and health projection omitted formation. These facts
prove diagnostic loss, not a native watchdog, signaling, or close/reset cause.
Task 15 delivered complete later health before finalizer teardown with bounded
formation facts and original failure precedence; Task 16 proved its normal
failure paths. Task 17 delivered one bounded, sanitized lifecycle sequence from
the canonical recorder, partitioned into the actual three agents after completed
health. Its independent review passed specification and approved quality with
zero findings; retained unit evidence covered 93 tests across nine files and the
maintained test typecheck. That review does not prove rare direct-spec finalizer
faults or a real failed window fitting the limits.

Task 18's exact-head non-publishing diagnostic
[37123318628](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37123318628),
attempt 1 on `bbf0f6b007a85234f9b9e970ab535ff3b4b391e2`, is terminal
COMPLETED/FAILURE: all three diagnostic jobs failed, source passed, accepted
capture/publication skipped. The watcher is retired; no producer remains.
Independent verification matched all 82 original files against complete sibling
inventories, sizes and SHA256s. The archive digests are GitHub-recorded, not
locally recomputed. Twelve scenario executions passed, three retention executions
failed, and twelve gated executions skipped. R1/R2/R3 failed at cycles 17/8/8
after 16/7/7 completed reconnects and retained 41/37/44 useful events (122 total),
including 4/6/5 positive timeout notifications. Each failure retained exactly
three distinct later-health agents and its frozen inclusive interval. Real prefix
loss and 12/6/6 oversized rows correctly mark incomplete coverage. Successful
and periodic outputs suppressed history; this is archived-output/source proof,
not runtime call telemetry. Normal pre-cleanup collection and original rejection
survived; deadline/unavailable/output/rare direct-spec cleanup faults were not
live exercised.

R3 retains B-side establishment/lane-open, opposite C-side timeout, then B-side
lane loss. The canonical facade event already carries peer/lane status, but the
projector discarded it. Later health cannot recover C's local state at that
notification. Task 19 delivered their bounded preservation in the existing pure
projector. Final independent specification review passed and quality was approved
on `7214bdd0288005bac4f34c4964f995adaa188d4e`, after an import-only correction
closed the sole Minor finding; no findings remain. The retained 105 passing tests
across nine files and 1,434 enforced test files with zero type errors belong to
pre-fix `8739df12f7a39d89d7e78acd42be76914617823d`; the import-only final head
received formatter, diff and complete import-layout verification, without a new
semantic/typecheck claim.

Task 20's exact-head non-publishing diagnostic
[37130139368](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37130139368),
attempt 1 on `7214bdd0288005bac4f34c4964f995adaa188d4e`, is terminal
COMPLETED/FAILURE. Source passed; all three diagnostic jobs failed; accepted
capture/publication skipped. Watcher 94391 is retired and no producer remains.
Independent verification matched all 81 original files, 4,081,384 inner bytes,
complete inventories, hashes and source. Outer ZIP digests are GitHub-recorded,
not locally recomputed. Twelve scenarios passed, three original retention
failures occurred at cycles 5/7/1, and twelve gated executions skipped. Every
failure preserved complete three-agent later health and its frozen inclusive
current-cycle-before-close interval.

The 100 useful events occupy 117,722 serialized bytes. All 94 peer-specific and
34 direct-lane observations match their event identities; ten timeout
notifications show locally non-established state and six establishment
notifications have an open lane. Each runner reports 12 oversized rows; R2 also
reports prefix loss. No output eviction, row cap, transport or deadline limit
fired. Twenty-seven non-failure snapshots suppress history. These archives prove
normal collection/publication paths and current notification state; rare
output/transport/direct-spec finalizer faults remain source/unit scope. They do
not prove an incorrect timeout guard or the native establishment cause.

Task 21 delivered bounded RTC AL commit/admission/qualified claim preservation.
Final independent specification PASS and quality APPROVED (C0/I0/M0) apply to
`dd2d9371b8146947548b9346027d05338c55a905`. The original nine-file 119-test
run belongs to behavior commit `99524`; final `dd2d` has 69 affected tests,
1,434 enforced test files with zero type errors, and declaration/body/import/
initializer equivalence plus layout/initialization review. Exact-source branch
release 37138443066 and both CodeQL analyses passed separately from runtime
acceptance.

Task 22's exact-source non-publishing diagnostic
[37138465392](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37138465392),
attempt 1 on `dd2d9371b8146947548b9346027d05338c55a905`, is final
COMPLETED/FAILURE: source passed, all three diagnostic jobs failed, accepted
capture/publication skipped. Watcher 29626 exited 1 and retired; no producer
remains. All 81 unchanged originals / 4,243,068 inner bytes passed independent
complete inventory/source/length/SHA256 verification; outer digests remain
GitHub-recorded only. Twelve scenario participations passed, original retention
failures occurred at cycles 10/5/1, and twelve gated participations skipped.
Twenty-seven non-failure snapshots / 81 agent entries omit history. Each failure
preserves complete three-agent later health, the frozen current-cycle-before-close
interval and original readiness rejection before normal cleanup. Rare deadline,
unavailable, output and direct-spec faults remain source/unit scope.

All 256 retained mixed events / 218,633 serialized bytes satisfy the unchanged
per-case combined bounds, schema, identity, link, clock and privacy checks:
53 commits, 49 admissions, 56 qualified claims (47 completed / nine retry),
103 matched and two unknown links. All 49 admissions have unique retained
other-agent same-message/type commit correspondence; 47 distinct admitted
messages have qualified completed work. R1 has 19 completed claims and zero
retry yet still fails. R2/R3 retry identities later complete and A–C establishes;
no causal B–C retry fix follows. R1 has prefix loss plus six oversized rows;
R2/R3 each have twelve oversized rows. No output, row or transport cap fired.

Completed AL work can bypass the dispatch port when local delivery is disabled,
a plan drops the message, or ordering is already complete. Retry can precede
or occur inside the port. The WS owner separately selects an exact-type callback,
ALL_IN fallback/wildcard and onAny observers; port settlement cannot establish
that the actual selected RTC consumer ran. Task 23 observes the exact callback
await and separate owned AL dispositions while preserving the published dispatch
signature. Consumer evidence is deliberately message/type/actual-agent scoped:
claim, attempt, lane and unique claim pairing remain unknown at that boundary.
A receiver can catch errors and native lifetime retirement can release awaiters,
so consumer return still does not establish native application. Task 23 fix1
received independent SPEC PASS / QUALITY APPROVED at
`72945dd6a198afacb68979914cb3cba7d8ab5612`; fix2 received the same zero-finding
verdict at `7b92d236c03e7d88c10706033aef9cbe98887f25`. Fix2 changed only the
measured private headless Brotli test ceiling from 299 to 300 KiB and plan facts;
runtime and diagnostic-budget bytes remain 729.

Task 24's exact-source non-publishing diagnostic
[37147329195](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37147329195),
attempt 1 on 72945dd6a198afacb68979914cb3cba7d8ab5612, is terminal
COMPLETED/FAILURE. Source passed, all three diagnostic jobs failed and accepted
capture/publication skipped. Watcher 19683 exited 1 and retired. Independent
verification matched all 81 original files / 4,262,002 inner bytes against their
complete inventories, lengths, hashes and source. Outer digests are GitHub-recorded,
not locally recomputed. Original retention failures occurred at cycles 1/8/1;
none completed 100 cycles. Later health contains all three actual agents; normal
failure collection preserves original readiness rejection before cleanup.

The 293 retained mixed events occupy 238,781 compact serialized bytes, including
38 exact-consumer terminal observations (36 returned, two retry), 38 separate
AL port decisions (36 returned, two retry) and 37 qualified claims. These prove
actual callback invocation/settlement and message/type/actual-agent correspondence,
not unique consumer claim/attempt/lane pairing or native application. R2 accepted
11,866,033 response bytes and retained the bounded 8,388,608-byte suffix; all
three histories also omit oversized rows. Missing rows remain unknown. Twenty-seven
successful/periodic health captures omit history. Rare deadline, unavailable,
output and direct-spec finalizer failures remain source/unit scope. The audit
passes diagnostic usefulness and the contract, not E3 acceptance or native cause.
Validated-routing/native-application-versus-retirement investigation remains
ignored, design-only preparation. Task 26 completed read-only diagnosis of the
actual first failure owners and earned no causal B06 correction, native
implementation or public dependency decision.

The controller separately verified BranchRelease 37149660443 and CodeQL/API
formation 37149660367 PASS at feature 7b92d236. Independent medium-scale
37149660315 attempt 1 failed: 2,757 medium-scale assertions passed, then the
cluster phase had 11 passed / one failed. Alice received the correct original
message/Bob-audience receipt with `timed-out` instead of `admitted`; Bob's room
frame arrived 57 ms after send, and the explicit ACK step was never attempted.
The managed runner exited before its fairness verification callback, so no
current-run fairness proof exists; the raw overdue fixture alone proves no
node-C acceptance. This is not an ACK defect, accepted load/performance result,
or a proved historical worker handoff.

Fix3 independently reproduced a concrete shared-worker defect at a fixed clock:
A dequeued the receipt while Alice remained open on A; B claimed that receipt's
committed local-recipient send and Alice received no admitted receipt. The same
literal semantic RED occurred with shared memory and separate production
PostgreSQL stores in one namespace. The existing planner now keeps clustered
receipt work process-independent via the existing cluster-receipt execution owner,
which resolves origin presence and publishes the canonical row when claimed.
The controlled tests pass after that minimum policy correction. Timing, authority,
receipt phases, persisted/public/wire contracts and diagnostic budgets are unchanged.
Fix3 independent review passed specification and approved quality with zero
findings at `80fa09acf5f9cc641d6ab67ff373f36d1296d924`. Its normal CI gates,
unchanged medium-scale/fairness gate and full-PR state-write comparison against
`c727caad561347a151a426579cf0d598e39f8ac4` passed. Independent original-artifact
review verified all 99 medium-scale files, literal admitted/ACK/complete receipts,
actual overdue FAIRNESS selection on B and substantive C participation. The
state-write audit accepted all 108 measured samples / 75,600 commands, four
A-B-B-A positions, complete durable/retry bindings and unchanged performance
and resource comparisons. These passes belong only to those source identities;
they neither establish the historical CI cause nor isolate receipt-fix speedup.

The real conflict with fetched upstream 54ad was resolved on the feature branch
in exact merge 13b. The two co-changed WS owners preserve consumer observations
and process-independent receipt work alongside upstream's explicit outbound
lanes and checkpoint store wiring. The merged headless entry measures 310,035
Brotli bytes / 302.7685546875 KiB; its adjustable private ceiling is the minimum
whole 303 KiB. Semantic exclusions and all diagnostic/workload limits remain
unchanged. Retained local integration checks passed: focused 39 tests / six
files, affected 3,026 / 310, PostgreSQL 19 / two, full unit 14,313 passed / 12
skipped, and 1,448 maintained test files with zero type errors, plus native
package/API/harness and bundle checks. The exact 54ad-to-13b changed-style gate
passed; full warning-only style is not whole-repository clearance. These are
retained runs, not new validation from this prose refresh. Independent integration
review passed specification and approved quality with C0/I0/M0. The exact feature
was published in
[PR #633](https://github.com/intact-software-systems/ar-eye-hunter/pull/633),
which remains draft, OPEN and unmerged at the latest retained controller read.

At exact 13b, normal CI passed. Medium-scale
[37161666829](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37161666829)
retains 99 verified originals / 72,456,165 bytes and 3,293 successful indexed
results. Its actual PR-merge checkout `b948bc7a07d18a47ec5f9192fa793634a33bd35c`
has candidate tree d545. Literal admitted/ACK/complete receipts, actual overdue
FAIRNESS selection on B and substantive C participation passed. Complete
indices do not recover omitted result bodies or truncated durable details;
the deliberate overdue fixture does not prove natural starvation or the live
receipt's preparing worker.

The historical exact-13b canonical state-write
[37161791161](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37161791161),
attempt 1, passed for exact 13b versus actual base/base-measurement 54ad with
zero harness overlay. All 48 originals / 2,045,954,228 bytes, 108 measured
samples / 75,600 commands and all 19 unchanged predicates passed independent
reconciliation. One unchanged offline pooling/comparison reproduced the hosted
pooled hashes across eight derived files. These are full-PR gates, not isolated
receipt speedup or RTC cohort acceptance. Shared lock wait +23.73%, shared buffer
hits +15.40%, hot buffer reads +20.87%, cohort drift, projected wire records,
host-isolation and outer GitHub-digest/retention-attribution limits remain.
Historical 80fa/c727 successes and the 7b92d236 failure stay distinct.

After those accepted exact-13b gates and a fresh source/delivery/no-live
entry check, Task 25 ran the unchanged non-publishing diagnostic
[37165604475](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37165604475),
attempt 1, on exact 13b. It is terminal COMPLETED/FAILURE: source passed, all
three diagnostic exercise jobs failed, original uploads succeeded and accepted
capture/publication were skipped. Sole watcher 20056 exited 1 and is retired.
Independent audit verified all 82 unchanged originals / 4,725,160 bytes against
complete inventories, lengths, hashes and source. No replacement or retry ran.

All nine ordinary/default executions passed. R2 all-scenarios passed; R1/R3
all-scenarios failed during initial realtime setup when the existing
`configureMeshTopology` PUT topology-config command returned AbortError. That
envelope does not prove the abort issuer, HTTP status, transaction outcome or a
native RTC cause. Retention failed canonical formation readiness at cycles
5/2/5, roles B/A/B; earlier completed cycles do not satisfy 100-cycle retention.
The returned inner readiness errors print a fresh rejection-time live summary
of connecting and the supplied browser wait budgets after refresh. They do not
retain the actual RTC wait-return state, terminal reason or predicate facts.
Root test/job deadlines did not expire. Later health remains a later snapshot.

Five failure captures retain 443 mixed events / 353,717 compact event bytes
across five independent unchanged budgets; all five have complete three-agent
later health and frozen inclusive windows. Twenty-three normal captures omit
69 history properties. All 57 exact-type consumer facts returned; AL separately
has 57 port-returned plus one port-retry decision, and 56 completed claims.
These unequal message/type/actual-agent observations do not pair uniquely to a
claim/attempt/lane or prove native application. The 48 oversized rows and two
suffix losses remain explicit; missing counterparts remain unknown. Outer ZIP
digests are GitHub-recorded only, global network/download count is unverified,
and recorder read count is source-backed. Rare output/transport/finalizer faults
were not live exercised. Strict new-history projection passed; broader original
artifact privacy is not certified, and the separately disclosed audit-inspection
frame-string output mistake is not erased by that scoped PASS.

The controller accepted this unchanged diagnostic contract/usefulness with
limits, while producer correctness failed and native cause remains inconclusive.
Task 26's complete first-failure diagnosis is accepted at its read-only scope.
No causal defect, shared native/receipt cause, causal RED or connectivity
correction is earned. At 13b the HTTP scope covers fetch and body parsing after request
preparation, but the error retains neither the reached phase nor owned abort
provenance; AbortError is not a proved timeout. Formation rejects from the RTC
result captured by `waitForRoom`, while its error text re-reads the live summary.
The actual rejected wait result is unretained; connecting text cannot replace it
or establish a timeout, missed wake or failed native application.

Task 27's complete source/export/consumer design was read and accepted before
observation TDD release. The existing HTTP owner now emits finite fetch/body/
response phase and the actual scope's first winning timeout/parent origin, or
false/null for no owned abort. This observes scope state, not rejection causality.
Formation rejection captures wait-return room state, summary/open/nonempty
predicates and peer counts before the later live-summary error read; its terminal
cause stays unknown. Original errors, requests, acceptance policy and budgets
remain. Both facts use the canonical runtime/recorder route and the existing
strict projection and shared mixed history budget.

Nine genuine missing-observation assertions failed against unchanged 13b while
72 controls passed; minimum GREEN passed all 81. Expanded focused validation
passed 96 tests in three files at the original implementation. These REDs establish an evidence contract, not a
reproduced B06 causal defect. Full touched-file closure removes unused internal
formation error injection, makes summary I/O explicit and gives abort forwarding
one owned lifecycle. Original-implementation validation at `7ef3354e3fa57a13ce951ea26b83304d1c7ba6f5`
has 96/3 focused PASS, 14,338 normal-suite
PASS with 12 skips, a 1,449-file zero-error maintained typecheck, passing shared-test
compilation and black-box/headless builds. The affected run had 4,143 PASS plus
the sole packaging-threshold RED, subsequently GREEN under its unchanged test.
Node localStorage experimental and Vite large-chunk warnings remain disclosed.
Independent review found an already-aborted helper path could abandon a started
operation's rejection (I1), plus a fixture setter name hiding notification (M1).
Fix1 reproduced both immediate and later losing rejections: cancellation identity
and immediate delivery held, but each operation raised one unhandled rejection.
The canonical helper now observes that losing promise without awaiting it; the
fixture operation is named `updateRoomAndNotify`. At published fix1 source
`0f6720afe82753044451527ce8fa6a32ce042e1c`, regression GREEN is 17/1,
focused validation 98/3 and affected auth/RTC/feature/AL/stream/runtime/boundary
validation 940/77, with zero maintained type errors across 1,449 files. The
historical normal suite is not attributed to this amended source. M2's disclosed
Node/Vite validation noise remains informational. No fix identifies a historical
B06 cause. Fix1's scoped independent review passed and publication completed.
At exact 0f, Branch Release 37175853020 failed its unchanged structure-coupling
checker on two formation mock-absence assertions; later static steps were skipped.
The supported-distributed 37175918004, formation 37175852897 and medium
37175852871 workflows reached SUCCESS at that earlier source. Their success does
not repair the required 0f Branch Release failure or certify current 93fc.

Fix2 replaces the two incidental mock-invocation assertions with actual owned
formation/RTC subscription state and captured diagnostic output, including a
capturing sink after the first injected sink failure. The exact immutable 0f
checker reproduced both reported candidates. Refined semantic coverage is already
GREEN without production changes: 98 focused tests in three files and 298 affected
runtime/readiness tests in 26 files; maintained types enforce 1,449 files with zero
errors. The unchanged selected-file checker reports zero candidates, and the
exact committed 93fc changed-range checker passed. Scoped fix2 re-review passed
SPEC/QUALITY with C0/I0/M0; earlier I1/M1 remain closed and M2 retains its disclosed
validation noise. Publication and required changed-source gate acceptance are
complete. These local fix2 checks belong to 93fc; the original 7ef normal suite
and 0f affected run remain historical and are not relabeled.

At exact 93fc, Branch Release
[37178242555](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37178242555),
formation 37178242373, medium 37178242410, supported-distributed 37178337825
and CodeQL 37178240219 all reached native SUCCESS. Independent medium acceptance
is PASS for correctness/load only: 99 originals / 72,028,795 bytes, 3,293 successful
indexed outcomes, literal admitted/ACK/complete receipts, actual controlled
FAIRNESS recovery on A and substantive C readbacks. Sampling/omitted bodies,
worker identity, clock, cleanup and privacy limits remain. Independent supported
acceptance is PASS only for the five supported recipes and ten agent executions:
115 originals / 12,919,599 bytes, with 22 diagnostic events and no host/geographic,
native-causal or performance conclusion. Current values do not inherit older
13b or 0f metrics. No new state-write comparison was selected for this slice;
the earlier full-PR 13b/54ad comparison remains historical.

The current Release workflow separately preserves an explicitly nonblocking
`npm run test:rallar:full-stack:memory:alm` FAILURE. Its 14 unchanged originals /
38,556,408 bytes are retained; inner runtime source/cause remains
UNVERIFIED/UNCLASSIFIED. Native workflow SUCCESS and the narrow medium/supported
passes do not turn that failed observation into conformance PASS. No waiver,
skip label or replacement producer repairs it.

At the original Task 27 implementation, the unchanged private headless bundle
test measured 310,471 Brotli bytes /
303.1943359375 KiB, 436 bytes above accepted 13b's 310,035 bytes. Its existing
adjustable packaging policy therefore sets the minimum strict whole-KiB threshold
to 304, from 303; the controller confirmed this bounded adjustment. The unchanged
boundary test also passes for fix1 at unchanged 304 KiB, with every operator-UI
exclusion and measurement preserved.
This changes no frozen workload, timing, sampling, evidence or performance-resource
budget. Task 28 used that unchanged reviewed, published, validated source for
one exact-source all-three non-publishing B06 proof, recorded below. No native/
public-DI design or causal B06 correction follows.

Task 28's authentic diagnostic
[37180571619](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37180571619),
attempt 1 on exact 93fc, is terminal COMPLETED/FAILURE. Source succeeded; all
three exercise jobs failed and uploaded successfully; accepted capture/publication
were skipped. Sole watcher 95988 exited 1 and is RETIRED, never to restart.
The controller accepted the complete independent audit, including its preserved
source checkpoint and reviewed finite proof. All 81 unchanged originals /
4,312,437 bytes passed complete source/path/size/SHA verification. Outer ZIP
digests remain GitHub-recorded only; global network/download count is unverified.

The actual 27 test slots reconcile to 12 PASS / three FAIL / 12 SKIP: nine actual
default executions and three actual all-scenarios executions passed; retention
failed at cycles 1/4/8 with primary rendered roles A/B/A. No accepted 100-cycle
cohort follows. Thirty captures contain 27 normal snapshots omitting 81 histories
and three failure windows containing nine histories. Complete A/B/C later health,
inclusive current-cycle-before-close windows, schema/link/loss accounting and
normal history suppression passed at their exercised scope. The windows retain
340 events / 268,243 compact event bytes across three independent unchanged
budgets, each below its own cap. Thirty oversized rows and runner 3 suffix loss
make coverage incomplete; unretained facts remain unknown.

All four captured formation records retain wait-return state `idle`, summary
available `true`, room open `false`, desired peers present `true`, desired count
2 and ready count 1. They are decision facts captured before printed live state
or later health, with wait terminal cause still `unknown`. Runner 3's additional
C rejection does not replace its A primary binding or prove cross-agent cause.
No retained HTTP failure observation exists: reached phase and first owned
timeout/parent abort remain source/test contracts, not exercised positive facts
from this diagnostic.

The windows retain 45 completed claims, 45 source-qualified exact-consumer
returns, 46 AL decisions and 45 port returns. Runner 3's extra AL disposition
remains UNCLASSIFIED. Positive callback settlement does not prove native
application or unique consumer/claim-attempt pairing. Absence of a cleanup-error marker
does not prove process termination or resource release. Rare HTTP, wait-rejection,
health/attachment/cleanup, transport/output and consumer/AL failure branches remain
unexercised or unclassified. Historical analysis-output lapses remain disclosed,
stopped and unrepeated; the reviewed bounded projection does not certify all
original artifacts or historical output as private.

Recorder origin/continuity, native application/generation, deletion issuer,
cross-agent causal order and one-way network latency remain unknown. No native
cause, accepted E3 primary/repeat, E1 reconciliation, ranking completion, checked-in
corpus increment or completed baseline follows.

Task 30 completed source-owned formation/wait diagnosis and one independently
reviewed finite later-health selector execution. Existing intended wait/formation
semantics passed seven files / 101 tests; meaningful synthetic utility REDs were
followed by 11 passing tests and independent full utility review. The one released
original-value execution exited zero with empty stderr and 72 safe rows: nine
later-agent, 18 peer, 36 lane and nine retained-lifecycle observations. Root accepted
the bounded interpretation and verified all 81 originals / 4,312,437 bytes unchanged.
The selector release is exhausted; no new producer or native/public-DI design was
activated. These are source/utility/evidence passes, not causal RED or performance
acceptance.

The four captured idle/non-open/desired2/ready1 rejections remain distinct from
nine later room snapshots. Later runner 1 has A/C connecting2/1 and B open2/2;
runner 2 has A/B connecting2/1 and C connecting2/0; runner 3 has all three open2/2.
Of 18 desired directed peers, 12 are ready and six are not; wrappers report 11 Open
and seven Connecting, with 24 of 36 lanes open. Runner 1/2 A-to-C is nativeNew /
ICENew / stable, without descriptions or aggregate offers; runner 2 queues one ICE
candidate. Runner 2 C-to-A has a local description / have-local-offer / absent
remote description alongside aggregate inboundAnswer1. These finite facts do not
identify offer initiation, native application or resource lifetime. All 18 reset,
stale-answer and signaling-error aggregates are zero, which cannot exclude prior
wrappers, explicit diagnostic reset or hidden work. All nine histories are
incomplete: 30 shared oversized rows plus runner 3 prefix loss, not 90 rows.
Current coverage remains UNKNOWN because current presence revision is absent.
Whole-health non-atomicity is not a proved explanation for runner 3's particular
nativeNew / ICEconnected / open-lane combination; connection fields read one PC
synchronously.

Task 31 completed independently accepted canonical handshake/lifecycle diagnosis
at byte-identical 93fc/21fd source. Existing QRtc offer-correlation/retirement,
retained-peer redial and lane recovery tests passed three files / 37 tests. Peer
admission, native negotiation, signaling receipt, native application, retirement
and notification are separate owned boundaries. A peer-deleted facade event reads
current status after a microtask and cannot identify the deleted native generation.
Wrapper counters, AL consumer return and peer identity do not prove native
application, generation, deletion issuer or historical cause.

At Task 31's source-only checkpoint, a watchdog scoped to original peer P checked
current object identity before synchronous timeout notifications. A legal one-shot
listener could remove P without refunding attempts, then admit Q for the same ID;
the subsequent unconditional ID-only removal disposed Q. Public synchronous
callback/removal/ensure contracts and existing deletion-observer replacement
semantics established the independent ownership hole. No checked production
timeout listener replaced a peer: browser notification was synchronous and the
black-box consumer only emitted diagnostics. No new replacement regression or fix
had run at that checkpoint, and no retained capture was associated with this trigger.

Task 33 witnessed two genuine original-production
RED failures, then two focused GREEN passes: timeout-listener replacement and
awaited lane-failure replacement. The two current-resource identity guards dispose
only the original resource and preserve a separately admitted Q, including Q's own
watchdog/attempt accounting. Independent scoped review accepted the minimum
correction and later non-clock closure: typed expected exhaustion, completed
constructor inputs/dependencies before owned construction, native failure-port
tests, removal of the fabricated overlay refusal test with the broader classifier
preserved, and required existing GroupRef fixture scope preserving eight identities.
No legacy adapter, migration or new production owner was introduced.

The human explicitly Approved the explained required readonly
`nowEpochMs: () => number` on exported `WebRtcConnectionService.Dependencies`.
One owned epoch source now serves the attempt budget, setup, once-established
state and entry-owned timeout event; timeout epochs are captured before synchronous
listeners, while relative scheduling remains AsyncCommand's existing timer.
Dynamic `() => Date.now()` reaches all 15 existing constructors; the new custom-clock
composer makes 16 sites. The initial 14-site inventory missed the namespace-qualified
public consumer: the maintained compiler exposed it, its required clock was added,
and the current maintained check passes. This approved external TypeScript dependency
adds no optional fallback, adapter, migration, native DI or policy expansion.

Checks retain their distinct scopes: ownership RED two failures / 65 skipped →
GREEN two passes / 65 skipped; approved-clock RED three genuine first-assertion
failures / 67 skipped → GREEN three passes / 67 skipped with all later assertions
reached. Historical post-non-clock service 67 PASS, overlay/classifier deletion
28 PASS and required-scope overlay 20 PASS stay stage evidence. Current local
focused lifecycle passed four files / 107 tests; consumers 23 / 276;
native-fixture/browser consumers 28 / 413; public boundaries three / 32;
additional public multicast consumer one / 16; benchmark contracts two / 18.
The latter include bounded 10-peer Node and one-item Deno diagnostic/overwrite
smokes plus synthetic contract cases, not accepted measurement cohorts.
Overlapping and historical checks are not summed.

Current shared, shared-web, benchmark TypeScript and 25 Deno entry-root checks
passed. Maintained types passed 1,449 enforced files / zero debt / zero errors.
Browser budgets and operator/headless builds passed; both builds retain existing
chunk-size warnings. Delivery status returned Action WORK before broad validation.
All 19 touched code owners pass formatting; changed style HEAD→WORKTREE passes
without new findings. Exact touched-source review disposed 14 legitimate cognitive
and callback signals with no layout finding; navigation reported zero findings,
and four construction warnings concern independently untouched adjacent owners.
Full default style exited zero with 3,400 warnings and a 200-finding display cap;
it does not prove whole-repository compliance. Structure passed; the singleton
multicast workload remains a direct, coherent domain/protocol owner.

Full recursive changed-file/support closure and scoped independent root source
review are accepted. Author and root remain separate; fresh reviewer dispatch
failed the service thread limit, and retained context is disclosed without a
fresh-context or review waiver claim. Completed exhaustion shape, native signaling
lifecycle ownership, canonical paired coordination snapshots with five explicit
variants, cache types and imports preserve values, inputs, timing, counters and
permissive diagnostic grammar. Final plan review and feature publication are
accepted at c3b3. Root accepted current required hosted correctness: Branch Release
37207693413 and every normal lane, including native-browser app/memory, passed;
the wrapper is terminal SUCCESS. Root inspected optional nonblocking ALM job
111452496121 only through its limited log: two PASS, one FAIL, nine selector SKIP.
Its first failure is Chromium smoke baseline rtc-with-ws-fallback at
full-stack-alm-conformance.spec.ts:122: the soft receiver outcome at line 272
expected true and received false; no timeout marker was observed. Cause and raw
artifact association remain unverified/unclassified, with no clock attribution.
Formation 37207693224 and Medium 37207693226 passed on checkout
`3f132a0409ef54b1cd02fd6d5e921c5a855f2a7e`; its merge parent includes c3b3 and
its tree equals c3b3. Root verified retained SHA/tree files, not every diagnostic row.
Supported 37207846626 passed all nine jobs/five recipes; root's bounded exact-c3b3
source/operation/isolation/hash and finite-summary review accepted correctness,
not B07, cleanup, historical cause or performance comparison.

Task 34's unchanged diagnostic
[37209071043](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37209071043),
attempt 1 on c3b3, is terminal FAILURE. Source passed; all three runner jobs failed,
all three diagnostic uploads succeeded, and governed capture/publication were
skipped. Root retained 81 original files / 4,317,090 inner bytes with exact
source/run/attempt, upload, path/size/byte-hash integrity. Independently reviewed
finite projection establishes 27 slots: 12 PASS, three FAIL and 12 selector SKIP.
Default and all-scenarios pass on every runner; retention-100 first failed at
recorded cycles 4/5/1. Bound later health is available for each failure. Recorded
history is incomplete: oversized rows 12/11/12 and R2 retained-prefix loss; shared
loss/count metadata is counted once per checkpoint, not recomputed raw-event
cardinality. No native/clock/role/lifetime/application/deletion-issuer cause,
cleanup proof or accepted E3 primary/repeat follows.

Newer merged ALM work [#627](https://github.com/intact-software-systems/ar-eye-hunter/pull/627),
[#628](https://github.com/intact-software-systems/ar-eye-hunter/pull/628),
[#629](https://github.com/intact-software-systems/ar-eye-hunter/pull/629), and
[#630](https://github.com/intact-software-systems/ar-eye-hunter/pull/630) shipped
codec/send-chain cost, cadence/readiness, browser storage truth, and one durable
owner with cross-tab session/work claims. The old design-only IndexedDB status
is obsolete. Their evidence does not substitute for B06 acceptance or prove the
RTC reconnect failure resolved.

Five Sep 28–Oct 2 B05 archives were recovered unchanged through ordinary
observation publication in
[PR #634](https://github.com/intact-software-systems/ar-eye-hunter/pull/634),
[PR #635](https://github.com/intact-software-systems/ar-eye-hunter/pull/635),
[PR #636](https://github.com/intact-software-systems/ar-eye-hunter/pull/636),
[PR #637](https://github.com/intact-software-systems/ar-eye-hunter/pull/637), and
[PR #638](https://github.com/intact-software-systems/ar-eye-hunter/pull/638).
The latest retained controller GitHub API read on October 4 at 00:59 UTC
confirms all six recovery PRs #634–639 remain OPEN and unmerged. Unknown
mergeability answers and synthetic test-merge commits do not establish a merge.
They remain proposed observations; the checked-in corpus counts above are
unchanged. Required repeats passed where needed. Oct 2 duration and first-open,
and Sep 29 first-open remain noisy/inconclusive. The publication HTTP 401 is
separate from capture outcomes; artifact recovery does not require replacing
capture identity.

## 2. Evidence Classes And Work Boundaries

Instrumentation measures canonical production code; capture executes unchanged
accepted workloads; evidenced correctness corrections require TDD and review;
optimization requires a separately scoped human decision after ranking.
Capture alone authorizes no optimization, retry, watchdog, or timeout change.

| Label                  | What it proves                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `synthetic-path`       | Relative cost/growth of a production in-process code path with complete synthetic native ports. |
| `native-browser`       | Chromium native peer/data-channel lifecycle and timings.                                        |
| `local-full-stack`     | Actual browser/API/server behavior on one machine with the named provider.                      |
| `distributed-observed` | Exact authorized manifest/fleet/provider behavior from retained artifacts.                      |
| `hypothesis-only`      | Source or incomplete runtime evidence that can direct measurement but cannot rank a hotspot.    |

Synthetic evidence is not network/browser/user latency. Native B05 does not
prove Rallar retention. Distributed evidence is limited to its proven manifest,
placement, network, provider, and commit. A static suspicion needs a measured
metric and attributable call path before it becomes a hotspot.

## 3. Current Production And Consumer Map

These canonical paths identify owners, not measured bottlenecks. Paths are
repository-relative; internal imports name owners directly.

| Capability                      | Current canonical owners                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signaling / ICE / reconnect     | `packages/shared/webrtc/qrtc-peer-connection.ts`, `packages/shared/webrtc/qrtc-signaling-contracts.ts`, `packages/shared/webrtc/decode-rtc-signaling-message.ts`, `packages/shared/webrtc/flush-rtc-ice-candidate-queue.ts`, `packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts`, `packages/shared/services/web-rtc-connection-service.ts`                    |
| Data channel / send queue       | `packages/shared/webrtc/qrtc-data-channel.ts`, `packages/shared/webrtc/rtc-data-channel-send-queue.ts`                                                                                                                                                                                                                                                                          |
| Multicast                       | `packages/shared/multicast/web-rtc-overlay-multicast-service.ts`                                                                                                                                                                                                                                                                                                                |
| Group/cache/heartbeat           | `packages/shared/services/web-rtc-group-manager.ts`, `packages/shared/services/web-rtc-group-service.ts`, `packages/shared/services/web-rtc-heartbeat-service.ts`                                                                                                                                                                                                               |
| Authoritative topology / replay | `packages/shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts`, feature-owned `planning/`, `mutation/`, `publication/`, and `replay/` below `packages/shared-server/rallar-system/topology/`                                                                                                                                                            |
| RTT                             | `packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts` and `packages/shared-server/rallar-system/rtc-rtt/inbox/`                                                                                                                                                                                                                                      |
| Browser RTC                     | `packages/shared-web/browser/rallar-rtc-facade.ts`, `packages/shared-web/browser/rallar-realtime-facade.ts`, `packages/shared-web/browser/rtc/browser-rtc-wait-runtime.ts`, `packages/shared-web/browser/rtc/browser-rtc-recovery-runtime.ts`, `packages/shared-web/browser/rtc-diagnostics/browser-rtc-diagnostics-runtime.ts`                                                 |
| API cluster signaling           | `apps/api-v1/src/db/api-v1-live-ws-notice-transport.ts`, `apps/api-v1/src/db/create-postgres-live-ws-notice-transport.ts`, `apps/api-v1/src/services/filter-eligible-live-ws-session-ids.ts`                                                                                                                                                                                    |
| Benchmark entry / result        | `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts` -> `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts`                                                                                                                                                                                                                                       |
| B06 production-facing recipe    | `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`, `tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts`, `tests/playwright/rallar-black-box/live-rtc-formation-operations.ts`, `tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts`, `tests/playwright/rallar-black-box/live-rtc-control-client.ts` |

Authoritative mutation policy remains owned by current repository standards:
AppInbox, durable authority, optimistic convergence, named effects, and existing
transaction/retry semantics. Measurement never bypasses those boundaries.
Room-scoped consumer examples remain at `examples/room-realtime-channel/README.md`
and `examples/room-message-channel/README.md`.

The RTC AL evidence path begins at
`packages/shared/alm/outbound/al-outbound-commit-phases.ts#toEvent`,
`packages/shared/alm/inbound/al-inbound-message-runtime.ts#recordAdmissionOutcome`
and `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts#recordClaimSettled`.
`al-inbound-runtime-diagnostics.ts#toALInboundClaimIdentity` owns message identity;
`black-box-rallar-diagnostics.ts#createBlackBoxRallarDiagnosticsPorts` emits through
the existing runtime recorder. `AppTopics.rtcSignaling` owns `rtc-signaling`;
native Offer/Answer/IceCandidate kinds are separate.
`al-inbound-admitted-delivery.ts#dispatchAdmittedMessage` observes owned pre-port
dispositions and port outcomes; `ws-queue-box-client-service.ts#dispatchExactConsumer`
observes the actual selected callback await. `ALInboundMessageRuntime` is publicly
exported by `packages/shared/mod.ts`; its three-argument dispatch signature and
public callbacks stay unchanged. The separate WS fact has no claim/lane identity
or unique claim join. `WsRtcSignalingTransportUsingWsQBox#registerInboxReceiver`
catches nested errors, and native lifetime retirement can release awaiters.
The private consumer remains
`tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts`, exercised by its
pure tests and literal `live-rtc-control-client.test.ts` capture HTTP boundary.

Shared WS receipt preparation belongs to
`packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts`;
`ws-queue-box-server-cluster-publication.ts#writeReceiptRow` owns canonical cluster
publication and execution-time origin resolution. Real AL work claims can cross
server instances. Receipt preparation therefore retains the existing cluster-receipt
work kind whenever a cluster publisher is registered; ordinary nonreceipt
cluster-local-complete and noncluster recipient delivery remain unchanged.

## 4. Implemented Harness Coverage And Timing Boundaries

The current [package guide](../../../packages/shared-rtc-bench/README.md) owns
executable navigation. Its catalog still has stale B04 held wording; the current
workload catalog and workers establish B04 tooling availability. The envelope,
fingerprints, per-iteration browser timings, B06 evidence producer, comparison
validator, and both observation/archive paths are implemented. Availability
never substitutes for an accepted artifact.

The catalog is `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-catalog.ts`;
manifest derivation is `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-manifest.ts`.
Workers live beneath `packages/shared-rtc-bench/workloads/`; package tests mirror
those capabilities beneath `packages/shared-rtc-bench/tests/`.

| Capability                         | Frozen measured interval / limitation                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 diagnostics / listener cleanup | Production diagnostic operation across deterministic peers; listener construction/connect/reset loop ends before cleanup inspection. Setup/cleanup effects retain complete native ports. Fake timings cannot establish native setup latency.                                                                                             |
| B01 ICE queue                      | Prepare 25,000 candidates before timing; time only production `flushRtcIceCandidateQueue`, sequential native adds, and success counters. Candidates queued during drain remain for the next drain.                                                                                                                                       |
| B02 replace / drain                | Separate queue fill/replacement/total intervals; drain begins immediately before buffered-low dispatch and ends after awaited production drain. Payload/setup/fill/serialization remain outside drain timing.                                                                                                                            |
| B02 close / error                  | Lifecycle interval includes construction, connect/open, queued sends and native close/replacement/low-buffer observation, or error dispatch; stop after retention/health inspection.                                                                                                                                                     |
| B03 topology / RTT                 | Build deterministic input/service before timing; time production topology update or room graph creation. Repository prepopulation precedes the `listMeasurementsForSessionIds` interval. Active churn and inactive projection/cleanup retain distinct intervals.                                                                         |
| B04 multicast / coordination       | Distinct originating-plan and serialization intervals; actual connection readiness is inside planning. Cache/group inputs precede repeated read/state/ownership intervals; heartbeat registers/removes callbacks on actual `QRtcDataChannel` owners prepared before timing.                                                              |
| B05 native lifecycle               | Fresh Chromium, 25 sequential open/send/close iterations with each open/close timing plus total soak; heap collection outside soak. Native-only evidence.                                                                                                                                                                                |
| B06 live RTC / retention           | Receiver-observed wait intervals; formation precedes cycle-0 diagnostics/post-GC heap. Every cycle closes C, proves both survivors observe absence, reconnects through the shared lifecycle owner, proves readiness, and records duration. Every tenth cycle captures diagnostics/post-GC heap; cleanup precedes final attempt evidence. |

B01 diagnostics retain the accepted one-retry/one-exhaustion input. Explicit
`reconnectAttempts = 5` selects the exhausted starting state; it does not claim
that five reconnects ran. Native timer/EventTarget/error ports are complete,
and setup/cleanup stays outside the declared operation intervals.

Standalone topology-delivery/replay diagnostics and maintained room-graph/RTT
probes remain outside accepted B01-B06 evidence. They do not receive accepted
status merely because their executable checks pass. Complete native port fixture
closure changed setup/call costs; before/after comparisons must use the same
current harness on both revisions. Preserve historical harness/source identity.

## 5. Accepted Workloads

The accepted Phase 1 measurement envelope retains `RTC-B01` through `RTC-B06`
exactly as specified here. `RTC-B07` remains conditional.

| ID        | Fixed workload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Required evidence and correctness assertions                                                                                                                                                                                                                                                                                                          | Class                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `RTC-B01` | Signaling burst: 500 polite/impolite pairs, producing 1,000 `QRtcPeerConnection` instances; 5 queued ICE candidates per polite peer; 3 offer collisions per impolite peer; and 5 inner runs. Run the ICE queue companion with 25,000 candidates and 5 runs and listener cleanup with 10,000 peers and 5 runs.                                                                                                                                                                                                                                                                          | Queued and flushed candidates equal expected counts; collision/reconnect/active/exhausted/ICE-restart counters match the script contract; final pending queue and listener counts are zero.                                                                                                                                                           | `synthetic-path`       |
| `RTC-B02` | Data-channel pressure: replace-key and direct drain at queue depths 32, 1,000, and 5,000 with fixed watermarks/payload and 5 inner runs; the existing replacement stress retains its 25,000 replacements; close-retention uses queue 32 with 5 runs; error-reference uses 5 runs. The direct drain case is implemented measurement instrumentation.                                                                                                                                                                                                                                    | Replacement/drain count and queue bounds match input; the simulated native-close callback retains only intended queued state; reconnect does not flush stale work; error leaves no attached fake-native handlers/reference.                                                                                                                           | `synthetic-path`       |
| `RTC-B03` | Topology/RTT: star, tree, and mesh at 30, 100, and 300 sessions, tree degree 5 and mesh parameter 2; sparse degree-bounded and complete RTT cases at the same sizes; current RTT repository filtering with room sizes 5 and 30 against 1,000, 10,000, and 100,000 global measurements; inactive churn in both `retain` and `cleanup` modes at 10,000 groups and 5 sessions/group.                                                                                                                                                                                                      | Each graph satisfies edge/topology invariants; current RTT filtering returns only fixed room sessions; churn reports modeled retain versus explicit cleanup; no authoritative state is mutated. The current RTT durable-ingress diagnostic remains outside the accepted timing set.                                                                   | `synthetic-path`       |
| `RTC-B04` | Multicast serialization: peers 10, 100, and 1,000 crossed with payloads 4,096 and 65,536 bytes. Group/cache: fallback with 20,000 snapshots, 5,000 matching versions, and 500 lookups; manager state with 5,000 clients, 1,000 desired, and 20 lookups; peer owners with 1,000 groups, 10 peers/group, and 1,000 lookups; heartbeat with 10,000 channels. Retain 5 inner runs in each existing harness.                                                                                                                                                                                | Transport-message, unique-serialization, byte, lookup, ownership, and callback counters satisfy each harness contract; all messages expected to be identical are byte-identical.                                                                                                                                                                      | `synthetic-path`       |
| `RTC-B05` | Native Chromium data-channel lifecycle: 25 sequential raw connection/data-channel open-send-close iterations per process, 5 independent measured processes after 1 discarded warmup process. Per-iteration open and close durations are implemented and required for capture. This is native lifecycle evidence, not Rallar reconnect-retention evidence.                                                                                                                                                                                                                              | 25/25 opens and closes in every retained process, zero local/remote errors, final channels and peer connections closed, forced-GC heap metrics present when Chromium exposes them.                                                                                                                                                                    | `native-browser`       |
| `RTC-B06` | Local three-browser matrix in memory mode: instrument the existing matrix artifact with receiver-observed peer-ready, direct-delivery, multicast-delivery, broadcast-delivery, and reconnect-ready wait durations; run 1 untimed default warmup plus 5 independent default executions and 1 untimed all-scenarios warmup plus 3 independent all-scenario close/reconnect executions on one exact clean commit/configuration. Run a gated 100-cycle Rallar close/reconnect mode in the same spec, 1 warmup plus 3 retained executions, with CDP post-GC heap and RTC diagnostic counts. | Every matrix assertion/artifact gate passes; receiver-observed timing distributions retain raw samples; all-scenario delivery survives reconnect; retention evidence is limited to the declared heap criterion and observable peer/lane state plus connection-timer flags returning to settled cycle-0 values.                                        | `local-full-stack`     |
| `RTC-B07` | Conditional remote sequence: first run supported preflight manifest `05a-rtc-realtime-stability-2-agent-5s.json`; if green and separately authorized, run `05c-rtc-realtime-stability-2-agent-30s-10hz.json` three independent times on the same exact commit/fleet configuration. `05c` assigns 2 agents; each plans 300 frames over 30 seconds at 10 Hz, for 600 aggregate planned frames; each has maximum in-flight 64, minimum sender success ratio 0.95, maximum 15 dropped frames, p95 send-completion at most 200 ms, and p99 send-completion at most 1,000 ms.                | Workflow operation succeeds; required artifacts are available and analyzable; per-agent sender thresholds pass. Receiver counts are correctness context, not a latency threshold. Preserve run IDs/attempts, commit, manifest hash, agent placement, artifact hashes, and do not claim multi-host/geographic placement unless the artifact proves it. | `distributed-observed` |

Postgres-backed `RTC-B06` is a conditional environment variant, not a
substitute for the required memory-mode run. It is required before selecting a
hotspot whose call path includes database-backed admission, topology
persistence, AppInbox, outbox, or cluster transport. It may be skipped only
with a recorded reason and may not support a conclusion about those paths.

### Frozen synthetic input details

`RTC-B02` keeps the existing deterministic replace-key payload function for its
replacement companion. The drain case uses a serialized payload padded and
asserted to exactly 256 UTF-8 bytes, unique keys `entity-0` through
`entity-(depth-1)`, high watermark 1 byte, low watermark 0, overflow
`replace-by-key`, and `maxQueueItems` equal to the tested depth. Fill with fake
native `bufferedAmount` fixed at 1 outside the measured interval; set it to 0;
then measure only from immediately before the buffered-low callback through its
awaited completion. Assert the queue is empty and exactly `depth` native sends
completed. Setup, fill, payload construction, and JSON serialization stay
outside the drain interval.

`RTC-B03` uses deterministic session IDs `session-000` upward. Sparse RTT is a
degree-4 circulant graph connecting each session to its two nearest neighbors
on either side; complete RTT contains every unordered pair. Both assign
`rttMs = 5 + ((fromIndex * 31 + toIndex * 17) % 96)` and monotonically
increasing versions in lexicographic pair order; there is no random seed. The
repository case uses `SyntheticRtcRttRuntimeStateRepository`, a fixed clock, live validated
entries in `RTC_RTT_LATEST_NAMESPACE`, complete target-room pairs first, then
deterministic non-room pairs until the fixed global count. Prepopulation is
outside the interval. Time only
`RtcRttRepository.listMeasurementsForSessionIds(roomSessionIds)` and assert the
returned count is `n * (n - 1) / 2`. This is an in-memory production-method
characterization; a database-backed conclusion requires conditional `E4-pg`.

`RTC-B07` uses manual dispatch of
`.github/workflows/hetzner-distributed-recipe.yml` (`Run Hetzner Distributed
Recipe`), not the supported-manifests workflow. For preflight, set
`manifest_path` to
`apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json`;
for retained runs use
`apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json`.
Set both the dispatch ref and input `ref` to the exact published instrumentation
commit SHA; `rollout_before_run=true`, `agent_source=hetzner`,
`operator_phase=full`, `agent_count=2`, empty `room_id`,
`agent_prefix=rtc-b07`, `application_id=rallar-server`,
`workspace_id=default`, `register_before_login=false`,
`browser_log_level=warning`, `headless_entry=headless`,
`browser_engine=chromium`, `install_playwright=true`, `npm_ci=false`,
`wait_for_agents=true`, `ready_timeout_seconds=120`, and
`stop_after_run=true`; leave control URLs at the workflow's recorded defaults.
Use unique run IDs `rtc-b07-05a-SHORTSHA-preflight` and
`rtc-b07-05c-SHORTSHA-1` through `-3`. The runner uses one `HETZNER_HOST`; the
two agents do not prove multi-host, WAN, or geographic behavior.

### Frozen configuration descriptor and worker grammar

Configuration identity is case-scoped. `RtcBaselineCaseKeyDto` is the exact
tuple `(workloadId, caseId, inputKey)`. A
`RtcBaselineConfigurationFieldDescriptorDto` is keyed by that tuple plus one
camelCase `field`; the same field name in two case keys is two descriptors and
may have a different default or environment source. Each descriptor has the
mandatory `flag`, `scalarKind`, `defaultValue`, and
`allowlistedEnvironmentVariable` fields, plus an
`environmentUnsetBehavior` of `use-default` or `reject` when an environment
variable is named. The flag is exactly
`--rtc-<camelCase-to-kebab-case-field>`. A case-specific resolved field records
the case key, field, normalized value, and exactly one source from `default`,
`cli`, or `environment`. Controller inputs such as baseline ID, phase, ordinal,
raw-result path, producer exit status, and output path are separate typed
records; they are never configuration fields. The generated canonical worker
projection is a fourth, separate record. No DTO collapses descriptors, resolved
values, controller inputs, or the generated projection into one map.

The manifest expands the following literal rows. Braces denote the complete
listed cross-product, not a runtime wildcard. Every named field has the shown
Section 5 default for that case; it receives the mechanically derived
`--rtc-*` flag and has `allowlistedEnvironmentVariable: null` unless the B06
table below names one.

| Workload  | Exact `caseId` / exact `inputKey` set                                                                                                                                                                                                        | Literal configuration fields and defaults                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RTC-B01` | `peer-connection-diagnostics-burst` / `pairs-500`; `ice-candidate-queue` / `candidates-25000`; `peer-listener-cleanup` / `peers-10000`                                                                                                       | respectively `peers=500, iceCandidatesPerPeer=5, offerCollisionsPerPeer=3, innerRuns=5`; `candidates=25000, innerRuns=5`; `peers=10000, innerRuns=5`                                                                                                                                                                                                                                              |
| `RTC-B02` | `data-channel-replace-key` / `depth-{32,1000,5000}`; `data-channel-drain` / `depth-{32,1000,5000}`; `data-channel-close-retention` / `queue-32`; `data-channel-error-reference` / `fixed`                                                    | respectively `queueDepth={32,1000,5000}, replacements=25000, innerRuns=5`; `queueDepth={32,1000,5000}, payloadBytes=256, highWatermarkBytes=1, lowWatermarkBytes=0, overflow=replace-by-key, innerRuns=5`; `queueDepth=32, innerRuns=5`; `innerRuns=5`                                                                                                                                            |
| `RTC-B03` | `topology-{star,tree,mesh}` / `sessions-{30,100,300}`; `room-graph-rtt-{sparse,complete}` / `sessions-{30,100,300}`; `rtt-repository-filter` / `room-{5,30}-global-{1000,10000,100000}`; `topology-inactive-churn` / `mode-{retain,cleanup}` | respectively `sessions={30,100,300}, innerRuns=5`, plus `degreeLimit=5` only for tree and `meshParamK=2` only for mesh; `sessions={30,100,300}, sparseDegree=4, innerRuns=5` for sparse and `sessions={30,100,300}, innerRuns=5` for complete; `roomSessions={5,30}, globalMeasurements={1000,10000,100000}, innerRuns=5`; `mode={retain,cleanup}, groups=10000, sessionsPerGroup=5, innerRuns=3` |
| `RTC-B04` | `multicast-serialization` / `peers-{10,100,1000}-payload-{4096,65536}`; `group-cache-fallback` / `fixed`; `group-manager-state` / `fixed`; `group-manager-peer-owners` / `fixed`; `heartbeat-callback-churn` / `fixed`                       | respectively `peers={10,100,1000}, payloadBytes={4096,65536}, innerRuns=5`; `snapshots=20000, matchingVersions=5000, lookups=500, innerRuns=5`; `clients=5000, desired=1000, lookups=20, innerRuns=5`; `groups=1000, peersPerGroup=10, lookups=1000, innerRuns=5`; `channels=10000, innerRuns=5`                                                                                                  |
| `RTC-B05` | `browser-data-channel-lifecycle` / `iterations-25`                                                                                                                                                                                           | `iterations=25`                                                                                                                                                                                                                                                                                                                                                                                   |
| `RTC-B06` | `{default,all-scenarios,retention-100}` / `{e3-memory,e4-pg}-{default,all-scenarios,retention-100}`                                                                                                                                          | `allScenarios`, `retentionSoak`, `retentionCycles`, `databaseProvider`, and `iceMode` exactly as resolved by the B06 table below                                                                                                                                                                                                                                                                  |

The only environment-backed configuration fields are these B06 fields. An
`unset` cell means the variable must be absent; a value other than the literal
accepted raw value is rejected rather than treated as truthy or defaulted.

| B06 case/environment                      | Field and flag                                                                                                                 | Descriptor default     | Exact variable / raw decoder / unset behavior                                                                                                                                                                                                  | Accepted normalized value/source                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `default` in `e3-memory` or `e4-pg`       | `allScenarios` / `--rtc-all-scenarios`; `retentionSoak` / `--rtc-retention-soak`; `retentionCycles` / `--rtc-retention-cycles` | `false`; `false`; `0`  | all three selector variables must be unset                                                                                                                                                                                                     | `false/default`; `false/default`; `0/default`          |
| `all-scenarios` in `e3-memory` or `e4-pg` | same three fields and flags                                                                                                    | `true`; `false`; `0`   | `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS` accepts only exact ASCII `1` and has unset behavior `reject`; the other two variables must be unset                                                                                                      | `true/environment`; `false/default`; `0/default`       |
| `retention-100` in `e3-memory` or `e4-pg` | same three fields and flags                                                                                                    | `false`; `true`; `100` | `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS` must be unset; `RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK` accepts only exact ASCII `1` and `RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES` only canonical unsigned decimal `100`; both have unset behavior `reject` | `false/default`; `true/environment`; `100/environment` |
| every `e3-memory` case                    | `databaseProvider` / `--rtc-database-provider`                                                                                 | `memory`               | no environment variable                                                                                                                                                                                                                        | `memory/default`                                       |
| every `e3-memory` case                    | `iceMode` / `--rtc-ice-mode`                                                                                                   | `repository-default`   | no environment variable                                                                                                                                                                                                                        | `repository-default/default`                           |
| every `e4-pg` case                        | `databaseProvider` / `--rtc-database-provider`                                                                                 | `postgres`             | no environment variable; required nonempty `DATABASE_URL` is a separate secret-bearing controller fact recorded only as `present`                                                                                                              | `postgres/default`                                     |
| every `e4-pg` case                        | `iceMode` / `--rtc-ice-mode`                                                                                                   | `local`                | `RALLAR_ICE_MODE` accepts only exact ASCII `local`; unset behavior is `reject`                                                                                                                                                                 | `local/environment`                                    |

`DATABASE_URL` is a secret-bearing producer connection input, not a workload
configuration value. The four `RALLAR_BLACK_BOX_RTC_*` identity/output
variables and `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR` are controller inputs,
not configuration. The B06 producer captures those controller inputs plus the
literal selector presence/raw-source facts and their normalized values in each
staged DTO, and checks them against its predeclared case before writing. The
later `record-external` process validates those stored facts and never rereads
the producer's expired command-scoped environment. This preserves the shell's
material distinction between an unset selector and an explicit `=1` selector.

Resolution precedence for every descriptor is exactly an accepted CLI flag,
then that descriptor's one named environment variable, then its case default.
An environment-backed descriptor with unset behavior `reject` stops before the
default step when no CLI value or named variable is present.
This precedence runs once on the separate controller-supplied configuration
inputs before generating the worker projection. Source `cli` means a
configuration option explicitly supplied to that controller boundary. The
generated trailing `--rtc-*` worker flags only transport the already resolved
values and never rewrite their stored source to `cli`; workers compare those
values while preserving the controller-resolved source. B06 instead preserves
and validates the source from its staged producer facts.
There is no prefix scan, full-environment read, alias, inferred variable,
helper default, or undeclared flag. For B01-B05 and the B06 fields whose table
has no environment variable, the environment step is absent.

The evidence contract stores two command records. The exact redacted executable
argv stores `executable` separately from the ordered `arguments` array and
preserves every actual token; only secret-bearing values become `[REDACTED]`.
The canonical worker projection stores only worker flags. Each manifest case
also owns its literal ordered runtime-prefix tokens through and including its
entrypoint. A generated common worker invocation is exactly the executable,
then that validated runtime prefix, then these one-token `--name=value`
arguments in order: `--capture=worker`,
`--baseline-id`, `--workload`, `--case-id`, `--input-key`, `--intended-phase`,
`--outer-ordinal`, `--sample-ids`, followed by every resolved `--rtc-*` flag in
lexical flag-name order within that case. Two-token `--name value` spelling is
rejected. `--sample-ids` is one comma-separated token in manifest order, and a
sample ID may not contain a comma. Booleans encode as lowercase `true` or
`false`; nonnegative integers encode as canonical base-10 ASCII with no sign,
leading zero, decimal point, or exponent; strings are their exact validated
UTF-8 value in the argument token with no shell quoting or normalization.

The runtime prefix is not normalized away: for a Deno worker it literally
includes `run`, the exact `--config=...` token, every exact permission token,
and the entrypoint in manifest order; for a Node worker it literally includes
the entrypoint and any predeclared runtime option in manifest order. A runtime
prefix may not contain a fixed worker or `--rtc-*` flag. Validation first
requires exact executable and runtime-prefix equality, then derives the
canonical projection only from the remaining trailing flag tokens. B05/B06
external producers are not misrepresented as common child workers: their staged
DTO preserves the actual producer executable argv and the separate canonical
projection derived from producer-captured facts, and validation compares both
records with the predeclared external case.

Validation derives the canonical worker projection from the exact redacted
argv, rejects noncanonical token spelling or order, and compares the derived
projection with the case descriptor and resolved values for common workers;
the preceding staged-fact rule is the external-producer derivation. Initialization,
capture, finalization, and every retained sample repeat that derivation and
comparison. The controller subcommand and controller-only options are never
part of the worker projection. Contract tests own the literal case descriptors
and argv/projection records; validation tests own precedence and reconciliation;
Deno-runtime tests own exact allowlisted environment capture; CLI-grammar tests
own the one-token encoding and rejection rules.

The controller protocol uses `baseline/command/rtc-baseline-cli-grammar.ts`
within the benchmark package as its canonical grammar. `initialize` also requires
one exact `--environment` value from `E1-local`, `E2-browser`, `E3-memory`,
`E4-pg`, or `E5-remote`;
conditional environment, decision, and nonempty reason options are all-or-none.
`initialize` accepts exactly one
`--workloads=WORKLOAD[,WORKLOAD...]` token. It rejects `--workload`, an empty
list, an empty member, a duplicate member, and any workload outside
`RTC-B01` through `RTC-B06`. The normalized initialization request and manifest
persist the accepted order as the nonempty `workloadIds` array; attempt, sample,
cohort, and failure identities retain one singular `workloadId`. `capture`,
`list-external-attempts`, `record-browser`,
`record-external`, `record-external-cohort`, and `compare-paired` each accept
one singular `--workload` that must name a member of the initialized
`workloadIds`. Repeat initialization accepts the nonempty ordered subset
printed by `repeat-required --format=workload-csv` and preserves that order in
the repeat request and manifest. It never infers an omitted workload list.

`record-browser`, `record-external`, and `record-external-cohort` accept the
producer result only as `--producer-exit-status=STATUS` plus
`--raw-result=PATH`; the aliases `--producer-status` and `--staged-path` are
unsupported and rejected. `list-external-attempts --format=tsv` emits exactly
four tab-separated fields in this order: case ID, intended phase, outer
ordinal, and environment. The external attempt's `inputKey` remains in the
manifest and typed locator but is never a fifth TSV field. These controller
option names and output columns do not change the staged DTO, locator,
workload, or evidence contracts.

## 6. Environments And Reproducibility

### Environment tiers

| Environment  | Required for                   | Rules                                                                                                                               |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `E1-local`   | `RTC-B01` through `RTC-B04`    | Quiet local machine; repository runtime/config; no parallel builds, test suites, browser matrices, containers, or other benchmarks. |
| `E2-browser` | `RTC-B05`                      | Repo-provided Playwright Chromium; headless; same browser build and launch flags for all retained samples.                          |
| `E3-memory`  | `RTC-B06`                      | Local memory API full stack using the root script and fixed three-browser identities; serialize with auth work and other services.  |
| `E4-pg`      | Conditional Postgres `RTC-B06` | Repository Docker/Postgres recipe, fixed migration state, local ICE unless the approved record says otherwise.                      |
| `E5-remote`  | Conditional `RTC-B07`          | Exact authorized Hetzner fleet, manifest, workflow input, commit, and retained operation/performance artifacts.                     |

### Required fingerprint

Before the first retained sample, record:

- full Git commit SHA, Git tree, branch/ref, and clean/dirty state;
- hashes of every workload script, manifest, and relevant config file;
- exact command with secrets and credentials redacted;
- Node, npm, Deno, Playwright, and Chromium versions when used;
- OS, kernel, architecture, logical CPU count/model, total memory, and whether
  the run is local, containerized, CI-hosted, or remote;
- provider, database mode, ICE mode, topology, peer/session/group counts,
  payload sizes, rates, duration, random seed, and run/sample identity;
- wall-clock start/end in UTC, monotonic duration source, and result units; and
- notable load, thermal, power, virtualization, network, or service deviations.

Never capture secret values, authorization headers, password values, private
keys, full environment dumps, or unredacted remote host inventories.

### Immutable source provenance over moving main

Each capture selects one clean immutable commit/tree/configuration snapshot and
records its required gates and fingerprint. E2/E3 workflows select main once
at dispatch/checkout; later main movement creates no recapture, rebase, deploy
anchor refresh, or quiet-main requirement. Keep each captured snapshot intact.

Never combine samples from different heads, trees, environments, providers,
browser builds, database modes, configuration sources, or workload inputs in
one distribution. For a cross-revision candidate, rerun the relevant workload
with the same current harness and frozen environment/input contract. Preserve
both evidence sets and compare internally homogeneous cohorts only when all
non-Git fields match. This comparison never pools distinct revisions.

### Warmup, samples, and run order

- Lightweight `RTC-B02` through `RTC-B04` scaling cases: execute 3 discarded
  warmups, then retain 15 fresh-process outer samples per fixed case. Preserve
  inner-run identity; do not silently multiply or average unlike levels.
- Heavy inactive-churn cases: execute 1 discarded warmup and retain 5 outer
  samples, with forced-GC heap/RSS capture when the runtime permits it.
- `RTC-B01`: its counters are primary; execute 1 discarded warmup and retain 5
  independent outer samples without describing fake-peer duration as setup
  latency.
- `RTC-B05`: discard one 25-iteration process, then retain 5 fresh browser
  processes of 25 iterations each.
- `RTC-B06`: discard one default warmup and retain 5 default executions; discard
  one all-scenarios warmup and retain 3 clean all-scenarios executions. A failed correctness
  run is a failed sample, not
  a warmup that may be discarded. For the 100-cycle Rallar soak, discard one
  and retain 3 fresh executions. Sample forced-GC heap and RTC diagnostic counts
  at cycle 0 and every 10 cycles. Mark primary heap retention failed when at
  least 2 of its 3 retained runs have final post-GC heap above both 110% of
  cycle-0 heap and cycle-0 heap plus 5 MiB. The controlled repeat preserves
  that two-thirds rule by failing heap retention at 4 or more of 6 retained
  runs, not 2 of 6. Independently, any retained run whose observable settled
  peer/lane state or connection-timer flags fail to return to their cycle-0
  values fails the cohort immediately. This is a bounded retention indicator,
  not proof that no unobserved object is retained.
- `RTC-B07`: retain the preflight plus three independent `05c` workflow runs.
  Do not rerun only to hide a failure; retain every attempt and explain it.
- Use deterministic IDs and seeds where supported. If a path is intentionally
  randomized, record the seed and retain the generated input.
- Distinguish cold-start and steady-state measurements. Never combine them into
  one distribution.
- Run only one performance workload on a machine/fleet at a time. Do not run
  repository gates, package installs, browser downloads, or artifact analysis
  inside a measured interval.

### Noise and comparison rules

For every duration, latency, throughput, byte, count, and heap metric, retain
raw samples and report sample count, minimum, median, maximum, and median
absolute deviation (MAD). Report p95/p99 only when the sample count and harness
semantics make them meaningful; remote manifests may use their defined frame
population.

A local metric is stable enough to rank only when:

- every correctness assertion passes;
- units, workload identity, commit/config, and environment fingerprint match;
- at least the required sample count exists;
- no retained sample is removed without a documented non-performance cause;
- relative MAD is at most 15%, or the result is explicitly labelled noisy; and
- sub-millisecond operations are aggregated enough to stay above the timer's
  practical resolution.

Local coefficient of variation above 10%, or distributed run-level coefficient
of variation above 20%, triggers one controlled repeat with twice the samples.
If it remains above the threshold, record `inconclusive`; do not keep repeating
until a favorable distribution appears.

The controlled repeat never appends to the primary directory. It uses the
unique primary baseline ID plus the exact suffix `-repeat-01`, references the
finalized primary summary/hash, keeps the original warmup count, and doubles
every retained outer-attempt count while preserving fresh-process and inner-run
rules. `repeat-required` exits zero only when a finalized primary summary
crosses the applicable coefficient threshold; with `--format=workload-csv` it
prints the stable sorted set of affected workload IDs, exits 3 with no output
when no repeat is required, and exits 1 for invalid/incomplete evidence. If any
metric in a workload triggers, repeat its complete frozen case matrix rather
than selecting a favorable case. `initialize` accepts
`--repeat-of` and `--retained-sample-multiplier=2` only for that triggered ID,
precomputes the complete repeat identity set, and rejects a second repeat. If no
threshold triggers, no repeat directory or identities are created.

The repeat link is the exact dense `RtcBaselineRepeatLinkDto` with mandatory
fields `primaryBaselineId` and `primarySummarySha256`. The hash is SHA-256 of
the exact finalized primary `summary.json` bytes and must equal the verified
`summary.json` entry in that primary's `SHA256SUMS`. Repeat initialization
persists the identical link in the repeat `environment.json`, capture manifest,
and finalized `summary.json`; initialization, finalization,
`readRepeatRequirement`, and `readPairedComparison` each confine and verify the
primary summary bytes, the primary checksum entry, both link fields, and exact
cross-artifact equality. A suffix-only relationship, a hash of parsed JSON, a
hash of `SHA256SUMS`, or a link to an unfinalized/unchecked primary is invalid.

A noisy result may motivate better instrumentation but cannot select a
production hotspot. Before/after comparisons use the same workload contract and
environment, alternate order (`A-B-B-A` or an equivalent counterbalanced
sequence), retain at least five local samples per revision, and report absolute
and relative median change with both distributions. A result is not a claimed
improvement unless correctness is unchanged, the change exceeds 10% **and**
three pooled MADs, and the relevant higher-fidelity tier does not contradict it.
These are evidence-reporting rules, not permission to optimize.

## 7. Correctness And Validation Routing

The benchmark package check is the current instrumentation gate:

```bash
npm run check --workspace=packages/shared-rtc-bench
```

The controller ran this unchanged package check during the refresh: TypeScript
and Deno passed; Vitest passed 45 files / 415 tests. It also ran the direct E3
semantics gate below: five files / 49 tests passed. These are baseline tooling
and semantic evidence, not TDD or fresh performance measurements from that
prose refresh.

```bash
npx vitest run \
  tests/unit/rallar-black-box/live-rtc-performance-evidence.test.ts \
  packages/tests/rallar-black-box/live-rtc-delivery-operations.test.ts \
  packages/tests/rallar-black-box/group-formation-lifecycle-driver.test.ts \
  packages/tests/rallar-black-box/live-rtc-formation-operations.test.ts \
  packages/tests/rallar-black-box/live-rtc-control-client.test.ts
```

For observation-tooling changes, select the package-local B06 runner, Deno
runtime, archive, and CLI tests under
`packages/shared-rtc-bench/tests/baseline/observation/`, then run its package
check. For an evidenced product correction, load its domain skill and select
focused semantic checks from current owners, for example:

```bash
npx vitest run \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-retained-peer-redial.test.ts \
  packages/tests/shared/qrtc-peer-connection.test.ts \
  packages/tests/shared/flush-rtc-ice-candidate-queue.test.ts \
  packages/tests/shared/webrtc/ws-rtc-signaling-transport.test.ts \
  packages/tests/shared/webrtc/rtc-delayed-answer-admission.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Browser recovery/wait/diagnostics checks now live under
`packages/tests/shared-web/rtc/` and `packages/tests/shared-web/rtc-diagnostics/`;
room public behavior checks are
`packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts` and
`packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`.
Use `npx tsc -p packages/shared-web/tsconfig.json --noEmit` for an affected
browser package. Public export/entry changes additionally require the existing
public API snapshots and browser bundle-boundary checks.

Topology/RTT checks now live under
`packages/tests/shared-server/rallar-system/topology/` and
`packages/tests/shared-server/rallar-system/rtc-rtt/`; select the exact changed
planning, runtime, mutation, publication, replay, or persistence boundary before
running `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
Authoritative mutations also require the convergent-service standard and fixed
medium-scale/topology-replay gates; mutation/concurrency changes require their
state-write comparative gate. They are not Markdown refresh chores.

A live diagnostic may use the unchanged correctness entry below. The accepted
primary must use the governed observation path and genuine provenance instead.

```bash
env -u DATABASE_URL -u RALLAR_ICE_MODE \
  -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS \
  RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 \
  RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 \
  npm run test:rallar:full-stack:memory:live-rtc-3 -- --retries=0
```

Use unique attempt outputs and isolate API/SPA/control ports when other work
owns the defaults. Serialize benchmark captures; diagnostics are never relabeled
as accepted metrics. Record passed/failed/skipped commands and exact reasons.
Run current focused gates before retained samples, keep broad validation
proportional to changed behavior, and use `npm run pr:delivery -- status` before
broad final validation. Resolve a real conflict first; mergeable `BEHIND` creates
no work. At publication handoff the controller runs
`npm run pr:delivery -- ready` once and stops when GitHub reports merged.

For plan prose changes, use pinned `npm exec -- dprint check <plan-path>`,
`git diff --check`, whole-file review, and semantic command/path/contract review.
Do not add an artificial source-text test or rerun unrelated unit/CI/build suites.

## 8. Artifact Contract

The canonical owner is
`packages/shared-rtc-bench/baseline/contracts/rtc-baseline-id.ts`. It accepts:

```text
Date-scoped: ^[0-9]{8}-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)(?:-repeat-01)?$
Workflow observation: ^([0-9]{8}T[0-9]{6}Z)-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)-gh([1-9][0-9]*)-a([1-9][0-9]*)(?:-repeat-01)?$
Local observation: ^([0-9]{8}T[0-9]{9}Z)-[0-9a-f]{12}-e(?:3-memory|4-pg)-local(?:-repeat-01)?$
```

Observation timestamps must round-trip as canonical UTC; workflow run/attempt
numbers are positive safe integers. Local observation timestamps retain
milliseconds and do not acquire a fictitious GitHub identity. Source commits
are full lowercase 40-character OIDs; IDs retain their first 12 characters.
Every repeat retains the exact primary ID plus `-repeat-01` and the verified
summary-byte hash link below.

For example, the exact fixture ID
`20260807-0123456789ab-e1-local` maps to this ignored local layout:

```text
tmp/perf/rtc-baseline/20260807-0123456789ab-e1-local/
  environment.json
  manifest.json
  .writer.lock
  gates/
  results/
  profiles/
  logs/
  artifacts/
  summary.json
  SHA256SUMS
```

`environment.json` contains the required fingerprint. Each raw result contains
the workload ID, sample ID, input, correctness assertions, units, monotonic
timings, and source script hash. `summary.json` references raw result paths and
hashes; it does not replace them. `SHA256SUMS` covers retained, redacted files.

### Integrity and failure rules

The shared B01-B06 evidence boundary must enforce all of these rules before an
artifact can be called accepted baseline evidence. The implemented common
contracts and external-ingestion path are canonical; B06 must not create
a second schema, Git/config/path policy, summary, or checksum owner:

1. **JSON-safe round trip.** Contracts accept only dense JSON values. Reject
   `undefined`, non-finite numbers, `bigint`, functions, symbols, class
   instances, sparse arrays, and implicit `Date` conversion. Validate the
   normalized artifact, serialize it, parse it, validate it again, and require
   deep equality with the normalized value.
2. **Live Git and source reconciliation.** Read `HEAD`, `HEAD^{tree}`, the
   current branch/ref, and `git status --porcelain=v1 --untracked-files=all` at
   capture start and before finalization. Both observations must identify the
   same commit/tree/ref and a clean tree. Hash every participating source and
   configuration file before and after the workload and reject any difference.
3. **Configuration-source reconciliation.** Every resolved workload field
   records its case key, field, normalized value, and one source from the closed
   set `default`, `cli`, or `environment`. Recompute the fully populated
   case-specific configuration and source from the stored controller-supplied
   CLI inputs, only the descriptor's named stored environment input, and its
   literal default; require its values to equal the projection derived from the
   exact redacted worker argv and every retained raw sample. Generated worker
   flags never become a second `cli` source. B06 external evidence uses the
   producer-captured staged facts and never a later environment reread. Do not
   read hidden configuration from a deep helper.
4. **Redacted command reconciliation.** Persist the exact executable and ordered
   argument tokens while replacing secret-bearing values with `[REDACTED]`.
   Require the manifest-owned executable/runtime prefix and derive the Section 5
   canonical worker-flag projection only from its trailing tokens; external
   producer records use their staged-fact derivation. Reject noncanonical
   `--name=value` spelling, scalar/sample encoding, flag order, case
   configuration, or fixed workload identity. Reject a record that contains an
   authorization header, credential, password, private key, token, unredacted
   database URL, or unredacted host inventory.
5. **Path confinement and exclusive creation.** Resolve every output beneath
   the directory named by the validated baseline ID under
   `tmp/perf/rtc-baseline/`; reject absolute paths, traversal, symlink escape,
   or any resolved path outside that directory. `initialize` creates the
   baseline-ID directory and initial files with create-new semantics and refuses
   an existing directory. Each accepted-evidence write acquires the same
   exclusive OS advisory lock and creates only new evidence files, flushing
   bytes before release. `.writer.lock` metadata is retained and marked
   `released`, so an older writer cannot delete a newer writer's lock.
   A process exit releases the OS lock; stale `owned` metadata is recoverable
   only with supported schema, same hostname, a non-future UTC timestamp at
   least five minutes old, and Deno signal-zero proof that the recorded process
   no longer exists. Malformed, remote, live, recent, future, or indeterminate
   ownership fails closed. Never manually delete/edit the lock to bypass this
   refusal; preserve the directory and use a new baseline ID after independently
   checking writer liveness. Initialization failure also reserves its directory;
   cleanup finishes before lock release and never recursively deletes it.
   The canonical mechanics are documented in the package README and owned by
   `baseline/evidence/rtc-baseline-writer-lock.ts`,
   `baseline/evidence/rtc-baseline-writer-lock-metadata.ts`, and
   `baseline/runtime/try-acquire-rtc-baseline-deno-writer-lock.ts` within the
   benchmark package. Evidence itself remains create-new/no-overwrite, with no
   resume, merge, or replacement path.
   The narrow staging exception is a serial external producer writing each
   reserved raw JSON path beneath that baseline's `artifacts/staging/`: validate
   the confined non-symlink path and create-new semantics. Staging has no
   accepted status until common locked `record-browser`, `record-external`, or
   `record-external-cohort` ingestion validates and accounts it. An active writer
   or existing target is a nonzero failure.
6. **Failure before exit.** If a workload or external-cohort correctness
   assertion/producer fails, acquire the exclusive writer lock, write one
   create-new failure artifact containing the attempted sample identity or
   cohort-assertion identity and exact member set, raw evidence, and typed
   issues, flush and release it, and only then return a nonzero process exit.
   Git, source, configuration, hash, or finalization validation failures follow
   the same persist-then-exit order once the writer lock is held. A
   lock-acquisition conflict fails nonzero without racing another writer. A
   failed attempt or cohort assertion is retained evidence and can never be
   relabeled as a discarded warmup or omitted assertion.
7. **Frozen inputs and identities.** Persist the Section 5 input beside every
   sample. An outer-attempt identity is the tuple `workloadId`, `caseId`,
   `inputKey`, `intendedPhase`, and `outerOrdinal`; one fresh process owns it.
   Every fixed inner run/iteration under that process has a precomputed sample
   identity adding `innerOrdinal`. `intendedPhase` is only `warmup` or
   `retained`, and ordinals are one-based. The serialized sample ID is
   `rtc-bNN-case-input-phase-OOO-III`, with three-digit ordinals. Outcome is a
   separate closed value `passed`, `failed`, or `not-run`; failure never changes
   the precomputed identity or intended phase. The same inner-sample identity
   may appear only once in a baseline directory.
8. **Complete sample-set accounting.** Derive the expected identity set from
   the frozen workload matrix and Section 6 sample rules before execution.
   `summary.json` lists every expected warmup and retained identity exactly once
   with outcome `passed`, `failed`, or `not-run`; failed/not-run entries require
   a typed reason. It also lists every predeclared policy-free cohort assertion
   exactly once and proves its member IDs equal the intended retained set.
   Reject missing, duplicate, extra, identity-mutating, silently discarded, or
   averaged-away samples/assertions.
9. **Homogeneous aggregation and recomputed statistics.** Build each retained
   metric cohort only from samples with identical head, tree, environment,
   provider, browser build, database mode, configuration values and sources,
   workload, case, input, metric, and unit. Reject any mixed field. Recompute
   count, minimum, median, maximum, MAD, and CV from the raw retained values;
   never trust a producer aggregate. Exactly 10% local CV does not trigger a
   repeat, while any value above 10% does. An explicit paired comparison first
   validates two such internally homogeneous cohorts and may differ only in Git
   identity; it preserves both summaries and never pools their samples.
10. **Conditional-environment decisions.** Before initializing a workload with
    a conditional higher-fidelity environment, persist one dense decision with
    environment ID, `required` or `not-required`, and a nonempty reviewed reason
    in the primary environment/summary/hash envelope. A repeat inherits that
    immutable decision. `not-required` is a recorded scope decision, not
    evidence for that environment, and cannot support a candidate whose call
    path triggers the higher-fidelity rule.

### Workload correctness invariants

The artifact validator recomputes these invariants from raw evidence instead of
trusting harness summary booleans:

- **B01:** queued/flushed ICE, collision/ignored-collision, reconnect,
  active/exhausted, and ICE-restart counters equal the frozen inputs; pending
  candidate queues and registered listener/handler counts finish at zero.
- **B02:** replacement and drain counts and queue bounds equal the selected
  depth; the direct-drain payload is exactly 256 UTF-8 bytes and completes
  exactly `depth` sends; close preserves only intended queued state, reconnect
  flushes no stale work, and error leaves no fake-native handler or reference.
- **B03:** session IDs, RTT pairs, versions, and RTT values match Section 5;
  star/tree/mesh and sparse/complete graphs satisfy their declared edge,
  connectivity, degree, and membership invariants; repository filtering returns
  exactly `n * (n - 1) / 2` target-room pairs and no foreign session; inactive
  churn reports the declared retain/cleanup state without authoritative writes.
- **B04:** transport-message, unique-serialization, byte, lookup, ownership, and
  callback counts match the frozen inputs, and every message required to be
  identical is byte-identical.
- **B05:** each retained process records 25/25 opens and closes, zero local and
  remote errors, closed final channel/connection state, all 25 per-iteration
  open/close durations, and forced-GC heap values whenever Chromium exposes
  them.
- **B06:** the implemented evidence producer recomputes every matrix
  assertion; receiver-observed peer-ready/direct/multicast/broadcast/reconnect
  timing presence; default/all-scenario identity; 100-cycle checkpoint count;
  and per-attempt settled peer/lane/timer state. After every attempt is accounted,
  the same B06 policy owner reads the immutable retained
  member set and emits a shared policy-free external-cohort assertion. It fails
  primary heap retention at 2 or 3 breaches among 3 retained attempts and a
  doubled repeat at 4 through 6 breaches among 6, preserving the accepted
  two-thirds rule; any retained attempt whose observable peer/lane/timer state or
  connection-timer flags do not return to cycle-0 values fails the cohort
  immediately. Failed, not-run, duplicate, extra, or missing members also make
  the assertion failed. The unchanged generic envelope preserves the attempt and
  cohort DTOs and independently enforces identity/member-set,
  Git/source/config/command, path, exclusivity, complete-set, summary, and
  checksum rules without implementing B06 policy.

A standalone/maintained diagnostic lacks the accepted envelope even if its
counters pass. Generated profiles/full local artifacts stay ignored under
`tmp/perf/`. Remote diagnostics remain within workflow retention and do not
become a B07 accepted result without its authorization and contract.

### Append-only observation archive

The shared observation owner wraps `observation.json`, `checksums.sha256`, the
finalized `primary/<observation-id>/` tree, and only a required finalized
`repeat/<observation-id>-repeat-01/` tree. A canonical external index row records
archive path, byte length, and SHA-256. The current append-only paths are:

```text
performance-observations/rtc-b05/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b05/index.jsonl
performance-observations/rtc-b06/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b06/index.jsonl
```

Before trustworthy initialization, tooling failure produces no ZIP. Afterwards,
a fully accounted failed primary is archivable with `acceptedMetrics: false`;
malformed or unaccounted evidence is rejected. Successful archive publication
never changes that outcome. A failed primary does not require a noise repeat.
Passing sample acceptance also does not erase persistent noise after repeat.
Verify every selected ZIP and its exact single canonical row using:

```bash
npm run perf:rtc-baseline -- verify-observation \
  --archive=<exact-archive-path> \
  --index-entry=<one-canonical-row-file>
```

The observation workflows own ordinary publication and narrow integrity checks.
If publication fails after verification, recover that same archive/row while
retaining immutable source/attempt identity; do not replace it with a rerun.
No repository progress ledger or source-text prose test substitutes for this
semantic archive verification.

## 9. Hotspot Selection And Stop Conditions

Candidate paths in Section 3 are hypotheses until runtime evidence reaches the
appropriate tier. Rank a candidate only after mapping an observed metric to a
specific call path with profiling, trace, counters, or bounded source
instrumentation.

Score candidates with four recorded factors:

1. user/system impact: connection latency, message latency, throughput,
   retention, CPU, memory, bytes, or fleet cost;
2. confidence: evidence tier, stability, repeatability, and call-path
   attribution;
3. reach: affected workload, consumers, peer/session/group scale, and frequency;
4. change risk: authority, compatibility, concurrency, public API, and overlap
   with active ontology/readability work.

Select at most one candidate vertical slice. It must have:

- green correctness gates;
- a stable result in one representative tier and corroborating evidence in a
  second tier, or an explicit human waiver explaining why the higher tier is
  unavailable;
- a measured material impact rather than file size, style, or intuition;
- an attributable production call path and explicit owner; and
- a separately scoped proposed change reconciled with active human work.

Stop without an optimization proposal when correctness fails, the result is
noisy, the call path cannot be attributed, the effect is not material, a
higher-fidelity tier contradicts it, or active work creates an unresolved
correctness/ownership conflict. The valid outcome may be “no optimization
justified yet.”

## 10. Delivered Outcomes And Remaining Acceptance

| Task    | Delivered outcome / remaining state                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | Execution authorization and initial foundations delivered; no renewed exact-blob activation ceremony.                                                                                                                                                                                                                                                                                                                                                                                  |
| 1       | One canonical dense artifact/configuration/identity/accounting/finalization boundary delivered.                                                                                                                                                                                                                                                                                                                                                                                        |
| 2       | B01 signaling/ICE/listener workers and semantic assertions delivered.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3       | B02 queue replacement/drain/close/error workers delivered.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4       | B03 topology/RTT/filter/inactive-churn workers delivered.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4A / 4B | Private package ownership and standards/legacy review delivered; current canonical owners replace old scripts. No relocation/migration slice remains.                                                                                                                                                                                                                                                                                                                                  |
| 5       | B04 multicast/group/cache/heartbeat instrumentation delivered.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6       | B05 per-iteration native lifecycle instrumentation delivered.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7       | Measurement gates/source-fingerprint tooling delivered. Current captures use their own immutable source snapshot, not a final-main anchor.                                                                                                                                                                                                                                                                                                                                             |
| 8       | E1 capture unverified: recover and validate retained evidence or perform governed capture after representative E3 succeeds. Tool availability cannot mark this complete.                                                                                                                                                                                                                                                                                                               |
| 9       | E2 stream active with 31 checked-in passed observations; five recovered Sep 28–Oct 2 archives are proposed in PRs #634–638. Retain noisy/inconclusive classification.                                                                                                                                                                                                                                                                                                                  |
| 10      | E3 has zero accepted primaries/repeats. Run 37108696378 recovery remains proposed in PR #639 at its last verified OPEN/unmerged status. Tasks 17–28 delivered reviewed bounded observations and exact-source proofs; Task 28 producer FAILURE retains usefulness PASS only. Tasks 30/31 completed source/evidence diagnosis; historical cause/native application/lifetime/issuer and unseen facts remain unknown.                                                                      |
| 11      | B07 held pending its separate human decision; no remote run in the current horizon.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 12      | Ranking gated on accepted E3 and required repeat plus reconciled relevant E1/E2 evidence; E4 remains conditional to the exact candidate.                                                                                                                                                                                                                                                                                                                                               |
| 17      | Bounded canonical lifecycle preservation delivered and independently approved with zero findings; one shared sanitized sequence, completed-health-first and failure-only capture.                                                                                                                                                                                                                                                                                                      |
| 18      | Exact-head non-publishing proof delivered: run 37123318628 attempt 1, source bbf0f6b007a85234f9b9e970ab535ff3b4b391e2, all 82 files verified, 122 useful events; normal-path scope and incomplete coverage retained.                                                                                                                                                                                                                                                                   |
| 19      | Existing peer/lane notification observations delivered; final independent specification PASS and quality APPROVED after the import-only fix, zero remaining findings. Retained 105 tests / 1,434-file zero-error typecheck are attributed to the pre-fix source.                                                                                                                                                                                                                       |
| 20      | Exact-head non-publishing proof delivered: run 37130139368 attempt 1 on 7214bdd0288005bac4f34c4964f995adaa188d4e, 81 verified original files / 4,081,384 inner bytes, 100 useful events / 117,722 bytes; all three original retention failures and honest losses preserved, watcher retired.                                                                                                                                                                                           |
| 21      | Bounded RTC AL preservation delivered; final independent specification PASS and quality APPROVED at dd2d9371b8146947548b9346027d05338c55a905 (C0/I0/M0). Original 119 tests belong to 99524; final dd2d has 69 affected tests and 1,434-file zero-error maintained typecheck plus declaration equivalence review.                                                                                                                                                                      |
| 22      | Final exact-source diagnostic run 37138465392 attempt 1: all three original failures at cycles 10/5/1, 81 verified unchanged files / 4,243,068 bytes, 256 events / 218,633 bytes; 53 commits, 49 admissions, 56 qualified claims (47 completed / nine retry), 103 matched / two unknown links. Normal-path scope and honest loss remain; watcher retired, no accepted metrics.                                                                                                         |
| 23      | Selected-consumer/AL distinction, controlled receipt handoff repair and exact 13b upstream integration are independently approved. Published 13b/d545 passed source-specific normal CI, medium/fairness and full-PR A-B-B-A state-write acceptance against actual 54ad. Historical 80fa/c727 successes and 7b92d236 failure remain distinct; no isolated receipt speedup or RTC cohort acceptance follows.                                                                             |
| 24      | Final exact-source diagnostic 37147329195 attempt 1 on 72945dd: 81 originals / 4,262,002 inner bytes verified; all three failures at cycles 1/8/1, 293 events / 238,781 bytes, 38 consumer terminals and 38 AL decisions / 37 claims. Normal-path proof, honest loss/identity/native unknowns and original failures preserved; watcher retired, no accepted baseline.                                                                                                                  |
| 25      | Complete unchanged diagnostic proof: run 37165604475 attempt 1 on 13b; 82 originals / 4,725,160 bytes verified; nine ordinary PASS, R1/R3 all-scenarios topology AbortError and retention failures 5/2/5. Five windows / 443 events / 353,717 compact bytes, 23 normal captures omit 69 histories. Contract/usefulness PASS with recorded loss/identity/privacy/branch limits; producer FAILURE, native cause INCONCLUSIVE, zero accepted cohorts; watcher retired.                    |
| 26      | Complete accepted read-only first-failure diagnosis at exact 13b; no causal defect/correction or causal RED earned. HTTP phase/abort provenance and actual captured formation wait result were missing at 13b; printed connecting state is a fresh live summary. Task 27 delivered bounded existing-owner evidence; native/public-DI design stays deferred.                                                                                                                            |
| 27      | Finite HTTP/formation evidence, fix1 and fix2 independently reviewed/published; exact 93fc required native workflows SUCCESS and medium/supported correctness acceptance PASS at narrow scopes. Current fix2 local checks are 98/3 focused, 298/26 affected and 1,449-file zero-error types. Historical 0f Branch Release FAILURE stays distinct. Current nonblocking ALM FAILURE remains UNVERIFIED/UNCLASSIFIED.                                                                     |
| 28      | Complete exercised observation/usefulness proof: run 37180571619/a1/source93fc FAILURE; 81 originals / 4,312,437 bytes verified, 12 PASS / three FAIL / 12 SKIP, retention cycles 1/4/8. Three failure windows / 340 events / 268,243 bytes retain four idle/non-open formation wait results. Loss, HTTP/terminal/native/claim/cleanup/privacy unknowns remain; sole watcher retired, zero accepted cohorts.                                                                           |
| 29      | Complete independently reviewed factual reconciliation and feature publication at 21fd/fae; sole prose child of 93fc, all protected acceptance regions unchanged. No runtime or hosted metric relabel.                                                                                                                                                                                                                                                                                 |
| 30      | Complete accepted source/finite later-health diagnosis: seven files / 101 existing tests, 11 synthetic utility tests, one reviewed execution EXIT0 / empty stderr / 72 safe rows. Four captured failures remain separate; later coverage/native lifetime/application/issuer unknown, histories incomplete. No cause, causal RED, fix or performance acceptance.                                                                                                                        |
| 31      | Complete accepted source-only handshake/lifecycle diagnosis at byte-equal 93fc/21fd; three files / 37 tests PASS. Independent timeout-listener replacement hole established; no new regression/fix had run at that checkpoint, and no historical capture association follows.                                                                                                                                                                                                          |
| 32      | Complete independently reviewed factual reconciliation, published at e89a57b85e415450291cc376778d31418435b6eb; protected acceptance regions unchanged.                                                                                                                                                                                                                                                                                                                                 |
| 33      | Complete narrow owned-code correction at published c3b3/b8d0: ownership 2 RED→2 GREEN and approved-clock 3 RED→3 GREEN, 15 existing+1 custom clock sites, recursive closure, independent review, local validation and required current hosted correctness accepted. Optional ALM limited-log first failure is inspected; cause/raw-artifact association remain unverified/unclassified. No historical cause or E3 acceptance.                                                          |
| 34      | Complete bounded unchanged diagnostic/retained finite review: 37209071043/a1/sourcec3b3 FAILURE; all three jobs failed/uploads succeeded, 81 originals / 4,317,090 bytes verified, 12 PASS / three FAIL / 12 selector SKIP, retention cycles 4/5/1. Bound later health available; incomplete history retains oversized rows 12/11/12 and R2 prefix loss. No native/clock/lifetime cause or accepted primary/repeat.                                                                    |
| 35      | Complete independently reviewed signaling observations published at 62f067706; required current Branch Release, formation, medium/fairness and supported correctness passed. Core semantic RED/GREEN, 201 focused passes and final 14-test/type cleanup verified. Browser Brotli cost +396 bytes; adjustable ceiling 238→239 KiB. Optional ALM cause remains unclassified; no causal or performance acceptance.                                                                        |
| 36      | Complete bounded changed-source diagnostic and finite retained review: all three runners failed/uploads passed; 88 originals / 5,980,973 bytes verified, 10 PASS / five FAIL / 12 selector SKIP, retention cycles 7/3/1. Reviewed reader earns 18 PASS and once-per-runner execution; 134 of 148 decisions retained with 14 tail omissions. Three caller retirements and one offer-mismatch Answer rejection observed; first failed phase/cause unknown, zero accepted primary/repeat. |
| 37      | Complete independently reviewed local event-pipeline measurement at docs-only d971/runtime62: four focused suites / 40 PASS, 60 fresh-fixture samples and four separate sampled CPU passes. Existing control-client retained-history scanning dominates large-history local cost; actual headless DOM included. Timing/noise/GC/fidelity limits preserved; no historical cause, E3 acceptance, optimization or new producer.                                                           |
| 38      | Complete independently reviewed finite failed-step interpretation of the same three retention logs / 48,250 bytes: three original CLI executions EXIT0, each result unclassified because no unique errored-step suffix is printed. All 88 originals remain unchanged. Source-authentic separator RED27/1→GREEN28/0 fixes reader formatting without an original rerun, phase/cause claim or E3 acceptance.                                                                              |
| 39      | Complete independently reviewed finite failure-detail interpretation: genuine RED/GREEN and final 32 PASS, separate same-log release with three EXIT0 executions / 813 output bytes. All three record generic Error and reconnect/canonical-readiness/formation-request frames; original operation/cycle and cause stay unknown. All 88 originals remain unchanged; no new producer, correction or accepted cohort.                                                                    |
| 40      | Complete independently reviewed read-only readiness source trace at inspection3f58/runtime62: all 39 bound owners unchanged; refresh, budget, command/result, cancellation and room-predicate boundaries recovered. Short/exhausted-budget mechanisms remain untested candidates; no historical causal defect, runtime correction or accepted cohort.                                                                                                                                  |
| 41      | Complete bounded local B06 reproduction at inspection3f58/runtime62: EXIT1/634.695s, one PASS/one FAIL/one selector SKIP, zero retries. Retention uniquely fails cycle17 reconnect/readiness with formation-not-ready message; two captured idle-room rejections have summary available and desired2/ready1. Native cause/first-error association unknown. Fresh memory services teardown verified; local environment differs from CI, zero accepted E3 cohorts.                       |
| 42      | Complete read-only source trace and bounded existing-projection review at inspection64/runtime62: 32 source/test/example owners unchanged; later ordinals1/3 have both lanes nonopen while ready to2. Captured idle does not distinguish layout coverage from timeout/abort suppression; captured peer/lane/terminal and native cause remain unknown. Originals unchanged; no regression, correction, new producer or accepted cohort.                                                 |
| 43      | Captured facts published at 3bd; its required static gate failed seven findings. Independently approved Fix3 published at 48cb727: 97 focused PASS/types/style/consumers PASS and required Branch Release/formation-large/medium PASS. Optional ALM FAIL unclassified; RTC integrity SKIP. Final headless 311682 B/305 KiB/638 B headroom (+139 B vs 3bd). Prior full suite remains 3bd; no E3 acceptance.                                                                             |
| 44      | One local diagnostic at unchanged 3bd: default PASS/retention FAIL cycle7 peer-C readiness/selector SKIP, 100-cycle target/zero retries. Captured timeout/reliable/desired2-ready1; later ordinal1→3 Connecting/native new/nonopen lane. History incomplete; child exit unavailable after wrapper failure. Nominal allowance/later state establish no deadline/generation/cause; 19 originals retained, zero accepted E3.                                                              |
| 45      | Authenticated original command/result and 6,398-row correlations narrow the A–C failure: adopted layout, matching Answers applied, retained-peer expiry invalidates later recovery pairing. Actual SPA hidden-history work reproduces 117–150 ms delay versus UI-off ~4 ms. Initial post-ICE native/channel failure remains unproven; observer presentation correction selected for design/TDD/review, no timer policy or E3 acceptance.                                               |
| 46      | Source-backed retry necessity assessment: failed native allocation can suppress the next same-peer lane repair, but no recovery RED has run. Independent correctness candidate only; channel-present B06 failure is not explained, no retry/deadline policy change selected. Observer correction remains active; E3 zero accepted cohorts.                                                                                                                                             |
| 47      | Observer correction at 65b257ab6; test/support closure fix at 9db431d2c. Semantic history suppression retains operator state and complete recordings; local correctness checks pass. Initial review required obsolete fallback/source-test retirement; scoped re-review approves the correction. No post-fix timing comparison or native cause established; E3 zero accepted cohorts.                                                                                                  |
| 48      | Hosted ac3 inventory/asset failures repaired at ab64/c62 with semantic polling proof, truthful transitions and full consumer closure; independent spec/quality APPROVE. Published at 92a6261 with fresh required Branch Release SUCCESS and independently accepted native formation/medium correctness on the identical tree. RTC integrity SKIP; diagnosis intact, E3 zero.                                                                                                           |
| 49      | Read-only native observation audit independently APPROVE/APPROVE at 92a6261: missing native lifetime/DTLS/SCTP/typed-error/candidate association and dropped timeout/deletion provenance. Bounded owner-captured observation design/TDD is next; original observer/expiry findings preserved, initial stall unknown, no retry policy or producer, E3 zero.                                                                                                                             |
| 50      | Corrected original-owner observation proposal independently APPROVE/APPROVE after scope/reservation, allocation-reentry, serialized-error and retired-channel corrections. Public additions and source limits remain proposed; human design approval pending, no implementation or runtime measurement. Initial stall unknown; Task45/46 findings intact, E3 zero, B07 held.                                                                                                           |
| 51      | Human approved end-to-end Off/Signaling/Full native configuration and implementation when the plan is ready. Source audits cover SDK/UI, general and distributed recipes, headless/CI and B06 identity. Complete specification and two-slice plan independently APPROVE after three finite readiness fixes; TDD execution is authorized, no code or producer yet. Task45/46 findings remain intact, initial stall unknown, E3 zero, B07 held.                                          |
| 52      | Complete canonical SDK/core capture selection and actual immutable construction readback at 7d8bd4d0 plus single-flight fix de006d74b. Specification/quality review approves both initialization owners after witnessed reentry RED/GREEN; final shared-web 169 files/1,395 tests and 1,454-file zero-error test types pass. Native remains explicitly unsupported until Task53; UI/recipe/agent/Actions/B06 application and hosted/performance acceptance remain outstanding.         |
| 53      | Original-owner bounded native evidence and queued-candidate correction are independently approved and published. Two historical TDD deviations were explicitly accepted, with no future waiver; length-only exceptions remain separate. The exact delivery-policy correction at884 passes local and independently audited normal hosted correctness. End-to-end configuration, native availability and B06/performance acceptance remain outstanding.                                  |
| 54      | Executable recipe/run intent and actual SDK attribution are locally reviewed after semantic admission-body/composite fixes. Published6d failed six coupling findings; support-only fix2 passes99 focused tests/types/current gates and scoped review. Normal hosted correctness is now independently accepted at853e with exact tested-tree identity,101 passing reports and fresh validation publication. Native/distributed/UI/Actions/B06/E3 acceptance remains outstanding.        |
| 55      | Read-only distributed source preparation is complete. It identifies missing run selection, explicit-target support bypass, lost actual receipts, unguarded reference bodies, restore/replay attribution gaps and missing runner selection. These are implementation requirements, not delivered behavior or new runtime-cause evidence. The resolved Task54 delivery failure preceded the source-derived SDK message prerequisite.                                                     |

## 11. Current Implementation Horizon

Tasks 29–39 are complete at their distinct accepted scopes. Task 35 is independently
reviewed, published at 62f067706 and accepted through required current hosted
correctness. Task 36 preserves a failed diagnostic and finite observations; it
accepts no performance cohort or causal diagnosis. Task 37 measures a local
observation cost; Task 38 preserves unavailable failed-step metadata rather than
inferring an operation. Task 39 locates recorded result-error frames at canonical
readiness; it does not recover the unique original step or cause. Task 40 traces
the existing readiness owners and tests without earning a historical causal
defect. Task 41 reproduces a local cycle17 readiness failure and retains two
captured shortages. Task 42 identifies a later unready current-session connection
and the missing captured authority/terminal discriminator, without earning a
native cause or correction. Task 43's capture is published; its hosted static
failure earned a locally validated, independently approved typed-boundary Fix3,
published at 48cb727 with required hosted correctness accepted. Optional ALM
failure and skipped RTC observation integrity remain separate. Task 44
retains a local cycle7 failure; its bounded facts and nominal allowance keep their
then-scope. Task 45 adds original correlations and actual SPA observer measurement:
late recovery pairing is invalidated by retained-peer expiry, and hidden history
presentation introduces measured delay. Neither fact proves the initial post-ICE native/channel
failure. Task 47 implements the selected observer correction with semantic TDD
and required local correctness checks; scoped independent review is approved.
Task 48 identifies two terminal hosted test-consumer failures on published ac3f5d95.
Their locally verified correction is committed at ab64b7822. Initial independent
review confirms those original repairs but requires two closure fixes. Fix1 at
c62dd5b5c establishes meaningful polling/shutdown proof and truthful transition
names, with recursive consumer closure. Scoped specification/quality re-review
approves the corrected head with no actionable residual. Publication at 92a6261
has fresh required Branch Release SUCCESS and independently verified native
formation/medium correctness on the identical tree. Task 49's read-only native
observation audit is independently approved. It proves missing owner-captured
lifetime/transport facts and lost timeout/deletion provenance; it cannot recover
the historical first-stall trigger. Task 50's corrected proposal is independently
approved at design-review scope. Task 51 adds explicit human approval for the amended
three-mode configuration and authorization to implement when the plan is ready.
The reviewed native ownership/error/budget design is retained; automatic native
enablement from a configured sink is superseded by explicit connection selection.
The approved epoch clock remains a separate decision. Task 52 delivers real Off and
Signaling selection, immutable construction receipts and typed incompatible reuse.
The initial review exposed compatible synchronous reentry at both transport and
session owners; fix de006d74b reserves the pending operation before synchronous
setup. Scoped specification/quality re-review approves both owners. At that published
checkpoint, Full native remained unavailable. The reviewed Task53 original-owner native
capture is now published in draft PR #633, after explicit human acceptance of the two
documented historical TDD deviations. Local source support does not establish target-browser
availability or accepted timing. The raw changed-style run reported 46 reviewed native
findings because the automated policy lacked their exact dispositions. The narrow
correction now passes the active gate with witnessed semantic RED/GREEN, preserving
thresholds, parser, tolerance and native runtime. Independent review approved the correction,
published at `884db0496cc6a4109a7fc90e225705da8551fce3`. Its normal hosted correctness is
accepted after checking actual checkout and artifact identities. End-to-end diagnostics,
supported-manifest and baseline/timing acceptance remain outstanding. Task56's message
intent, handle-specific receipt and final admission fence now have independent
specification/quality approval after a witnessed test-first correction of stale
storage-to-volatile admission. Its corrected frozen suite passes 14,661 tests with
12 skipped; current changed gates, browser budgets and four app builds pass.
Delivery continues through draft PR #633. Initial Branch Release app-browser validation
fails the observer-report disclosure check on published `12eaac58e`; its following memory
full-stack step is skipped. The unchanged focused browser spec reproduces the failure.
Read-only instrumentation and the actual reset call path identify a test-readiness race:
the first event is injected during asynchronous bootstrap reset and cleared 97 ms later.
The report correctly follows recorder history. The same implementer is released for a
minimum test-readiness correction, preserving reset behavior and all assertions. The
same focused browser spec passes both cases, but a broader run exposes the second case's
own startup-reset race. Scoped review closes the first finding and requires correction
of the second before delivery. Both failures now have actual reset/event chronology;
the minimum second readiness correction now passes the original focused pair with default
tracing. Original-reviewer scoped specification/quality approval, the covering repeat
(46 PASS/64 SKIP) and in-memory full-stack checks (seven PASS) are complete. Fresh
hosted delivery is now independently accepted for published `a74be0ee561494085f2c18dce38264e404ee792b`.
All three required workflows succeed; actual checkouts and the fresh validation artifact
match that source/tree. Task57 Connect readback is now independently accepted and published.
Task58's initial application/currentness checkpoint is published at
`431a77b93ccae63d7ca7ad8869838086e1201967`, with all three normal hosted gates independently
accepted. Its unpublished acquired-send successor has witnessed semantic RED/GREEN.
The review's unreachable live/tab resources finding is corrected and independently closed;
quality remains unaccepted for the separate public encrypted-output typing decision.
The next two useful implementation actions are:

1. **Repair the real parent conflicts:** combine current main's canonical exclusive-audience
   routing with the parent's capture/acquisition and final admission guards. Establish the
   integrated headless packaging allowance from its maintained measurement. Complete
   semantic tests, changed-owner standards closure, independent review and feature
   publication before preparing a fresh exact default-branch proposal.
2. **Forward and apply worker/Actions intent:** carry HOST through existing environment
   and Actions variables, and optional finite operator RUN selection through the existing
   distributed/GitHub-Free adapters. Use the canonical validator and precedence, preserve
   omission and authored recipe/step intent, and prove actual launched SDK application.
   Serve the existing headless app alongside API/control for that acceptance. Existing
   storage/recipe, spawned/external/mixed/no-spawn and B01–B06/E3 outcomes remain required.

The WS fixture correction and exact9d normal hosted acceptance are complete. PR633's real
conflicts require repair and fresh review before a new exact integration proposal; no
governed E3 cohort is accepted. After the
required source and cohort preflight gates are satisfied, use the unchanged E3 primary and
conditional repeat. Neither normal CI nor these two local implementation slices completes E3.

Immutable7c3 full-body/diff coverage is complete across all257 paths; its adverse review
remains retained. HTTP credential routing, startup context forwarding and B06 emitted-schema
corrections now have independent local SPEC/QUALITY/full-file acceptance. The exact
current-main e366 reconciliation is independently accepted in local merge12197c38,
tree617062ab, preserving membership fencing and reviewed RTC capture/admission. The
fixture and current policy corrections are independently accepted. Correct-e366 delivery
checks pass; final corrective code/architecture review and all18 structural dispositions are
accepted. Scoped prose review passes and that corrective batch is published at a3. Its later
WS fixture failure is closed by the reviewed9d correction and fresh normal hosted acceptance.
Original failed evidence remains retained. No source concern
alone authorizes a CRDT, retry, timeout
or immutable-context redesign; held original successors remain excluded.

B06 selection/application and producer/cohort sealing are published at7c3 and have local
Native correctness plus fresh normal hosted acceptance. After the corrections and complete
review, obtain the repository's exact default-branch approval where required and select the
reviewed immutable main source for the requested E3 primary. Preserve3 warmups and11
measured attempts, the existing controller's conditional3+22 repeat,100 cycles for the
retention case, zero retries and every failure.
Do not overlap measurement with agents, tests, builds, downloads or artifact analysis.

Manual's bounded implementation is now independently accepted:39 unit cases and2 actual
browser cases pass, and specification/quality reviews approve all eleven touched files.
The Connect-to-Join correction separately passes154 cases and both reviews. These working-tree
results do not certify publication, the remaining Task59 Recipe Console work or E3.

The concrete two-owner encrypted-output proposal remains pending explicit maintainer approval.
It preserves authored input typing and runtime encryption while returning canonical base-batch
carriers. The resource correction releases only its live/tab resources, preserving persisted
data and original refusal. Task58 remains correction round3/5 with no blanket cleanup redesign.

The cleanup-error control now extends the same acquired-send family to six cases:
two meaningful failures and four passing controls, with49 complete-owner controls passing.
Root accepted the terminal evidence and independently verified the minimum single-document
functional GREEN. Scoped independent review closes I1/M1; quality remains unaccepted for the
public typing disposition.
Manual semantic RED is also accepted: selected modes are lost from commands, cache and export,
and the real full-stack page lacks the capture selector. The live getter's active transport
ownership through close/reset and replacement is traced; the six existing Manual owners are
released for GREEN after the corrected Inherit-option RED. The selector and initial preference
checks now pass in the real browser. The default-room routing repair passes39 unit cases;
the following real failure identifies dropped capture intent during room join. Its reviewed
forwarding correction and the two test-only corrections now allow every applied receipt and
preference-reset assertion to pass. Final Manual scoped review and delivery remain.

Inline distributed capture follows these operation prerequisites. It still requires one
finite run override, capability/version checks for every actual assigned target, and
bounded positive per-agent evidence through real redaction, protocol, storage and export.
Requested settings, advertised support and global getter readback cannot prove application.
Its preparation remains a draft because message-handle evidence alone cannot certify
live document work. The executed Connect and startup regressions have distinct accepted
scopes. Full Task58 still requires finite acquired-message transport/document/page
readback and fresh/configured/cached/custom boundaries; its cleanup finding has independently
witnessed semantic RED and a reviewed minimum correction. Public typing disposition remains held.

The full amendment still requires general/distributed recipe configuration and
per-agent application receipts, visible Manual/Recipe Console controls, local/headless
and GitHub Actions propagation, and B06 sealed-mode/cohort validation. These remain
required outcomes. Task54's behavior is locally validated after the two Important review
corrections and scoped specification/quality approval. Its final frozen suite passes
14,607 tests with 12 skipped. The support-only coupling correction now passes its actual
changed-range gate and scoped review. The fresh853e hosted checkpoint below accepts normal
correctness at that exact source; it does not certify subsequent implementation. Task55's source trace
is complete; the two distributed outcomes above follow its verified current owners.
No final amended acceptance is claimed by the staged Full native unavailable result.
A separately selected unchanged B06 availability/first-stall/perturbation exercise
will establish target API support, adequate retained capture and acceptable overhead.
No new RTC producer or retry policy follows automatically.
Section 9's stop and all baseline gates remain intact.
Task 33's owned-code correction
remains accepted at c3b3; the human's required-clock approval persists.
Whole-file closure covers every changed human-authored file and recursively changed
support file; independently untouched code remains outside closure. Author/root
separation and retained context after failed fresh-reviewer dispatch remain disclosed,
with no TDD, review or standards waiver. Neither correction nor diagnostic exercise
proves the historical B06 cause or accepts a performance cohort.

### Task 34: Completed diagnostic exercise and bounded retained evidence

**Current outcome:** Run 37209071043/attempt 1 on published c3b3 is terminal
FAILURE. All three runner jobs failed and diagnostic uploads succeeded; source
passed and governed capture/publication were skipped. The 81 retained originals /
4,317,090 inner bytes have accepted integrity. Actual participation is 12 PASS /
three FAIL / 12 selector SKIP across 27 slots; retention first failed at recorded
cycles 4/5/1, with bound later health available and incomplete history on each.
Oversized rows 12/11/12 and R2 retained-prefix loss remain explicit. Finite scalar
review preserves missing/invalid facts as unavailable and shared loss once per
checkpoint; it does not certify full history conformance, causal/native association
or cleanup. No further producer or value read is released by this milestone.

- [x] Complete Task 33 publication and required exact-source hosted correctness.
- [x] Independently accept bounded B06 source preparation and dispatch one unchanged
      diagnostic with mode=diagnostic.
- [x] Retain all terminal originals, including failures, with actual upload metadata
      and exact source/run/attempt/path/size/byte-hash integrity.
- [x] Independently review the finite projection and actual participation, first
      failures, later-health availability and recorded coverage/loss limits.

**Exit:** Terminal producer and retained-evidence interpretation are accepted only
at their bounded diagnostic scope. No Issue was created or reused. Current optional
ALM's first failure remains inspected only at limited job-log scope; cause and raw
artifact association remain unverified/unclassified, without clock attribution.

### Task 35: Published signaling observations and required hosted correctness accepted

The existing service, native peer and caller now record their own decisions through
one synchronous immutable observation contract. Browser composition installs the
complete optional capability before signaling connects, sharing the approved owned
clock. Disabled diagnostics, invalid/throwing supplemental clocks and throwing sinks
preserve business outcomes. Answer rejection retains the actual current-PC,
offer-match and signaling-state qualification from one evaluated branch. Late native
return/rejection remains qualified to its retired capture; the first accepted caller
release cannot be relabeled by a later abort or completion. Native operation return
does not prove readiness or an end-to-end application receipt.

The existing recorder/projector uses one mixed retained history and unchanged
transport, scan, row, output, eviction and loss limits. Producer, runtime and control
timestamps remain separate. Missing/invalid facts stay unavailable; offer IDs require
validated Offer/Answer. Raw payloads, SDP, ICE, tokens, errors, policy reasons and
arbitrary extras are omitted. No generation, role, deletion issuer, lifetime identity
or AL claim join is invented, and lost coverage remains incomplete/unknown.

Core assertions earned six RED failures/one control pass before seven GREEN passes;
the reentrant retirement mutant and offer-ID privacy regression also fail meaningfully.
The initial browser assertion had dispatch-timing uncertainty: the strengthened test
waits for the actual public AL consumer retry, and its saved GREEN precedes the
original-composition replayed RED. That discrimination is not retrospective TDD order.
Fixture/type errors and the initial bundle overflow remain recorded as such.

Local checks passed: six focused files/201 tests; final test-only public-port cleanup
then 14 new tests and 1,450 enforced test files with zero debt/errors; shared,
shared-web, shared-test and reusable native benchmark checks; public API snapshots,
entrypoints and browser/headless boundaries; UI/headless and both game consumer builds.
Final changed-style and four-test structure reviews passed, with zero current
structure-coupling candidates. All touched files and recursively changed support were
reviewed; unchanged owners reuse their exact prior full reads. Same-author/root review
and the failed fresh-reviewer dispatch remain transparent. Build chunk-size advisories
remain. Final browser Brotli is 244,095 bytes versus 243,699, a 396-byte observation
cost; the explicitly adjustable ceiling changes only 238→239 KiB, leaving 641 bytes
of headroom. No performance improvement or recorder/workload relaxation follows.

Required hosted correctness passed on the published implementation: Branch Release,
formation, medium/fairness, and all five supported distributed recipes. Formation
and medium checkout provenance binds their validated tree to the candidate. The
supported artifacts retain zero blocking failures, parser warnings and failed,
missing or stale agents; 22 warnings/errors remain diagnostic context. Its 5-second
05a smoke delivered all 50 scheduled frames and is correctness evidence only.
Optional ALM retains two PASS / one FAIL / nine SKIP and the inspected receiver
boolean failure; no new cause or raw-artifact association is certified.

### Task 36: Failed diagnostic preserved; signaling observations interpreted

The sole changed-source diagnostic on published 62f067706 completed with all three
runner jobs failed and uploads passed; governed capture/publication were skipped.
The 88 originals / 5,980,973 inner bytes have exact source/run/attempt, native ZIP,
member, path, size and byte-hash integrity. Across 27 test slots, actual participation
is 10 PASS / five FAIL / 12 selector SKIP. All three retention invocations failed
at recorded cycles 7/3/1; all-scenarios also failed on runners 2 and 3. These are
preserved failures, not accepted metrics.

The existing ignored reader/test pair was amended after immutable before snapshots,
using canonical decoder/disposition owners and explicit reviewed source/inventory
bindings. Four meaningful missing-output REDs, one HEAD-guard RED and one ambiguous
healthy-subset RED preceded their fixes; final 18 tests and explicit ignored-file
formatting passed. Unsupported import-probe and no-file formatter failures remain
classified as setup failures, not semantic RED or compliance evidence. Same-author
implementation and root independent full-source/specification/quality review remain
disclosed. One bounded execution per runner passed with empty stdout/stderr; the
complete 175 safe rows / 88,422 bytes were independently read.

Each unique bound retention window preserves ordered Offer/Answer service, native
and caller observations without private identities or call pairing. Of 148 valid
decisions, 134 are emitted; runner 1's third stored agent has 14 additional tail
omissions. Invalid decision counts are zero within the inspected retained subset;
that does not establish completeness. Upstream retention coverage is incomplete
with oversized rows 6/12/12; runner 1 also loses its input prefix. Runner 2's
all-scenarios failure has separate incomplete coverage and prefix loss. Recorded
upstream loss is counted once per checkpoint and stays separate from projection
loss.

The retained subset records three Offer caller releases as lifetime-retired with
current-PC false, plus one Answer-ineligible decision with captured/current PC true,
offerMatches false and signalingState have-local-offer. Other retained native
remote/local-description returns remain observations of captured calls. They do not
prove a receipt, readiness, native cancellation, a shared lifetime or the failure
cause. Unreturned work is unresolved in the window. First failed phase remains
unclassified: later health and a retention sidecar cannot establish readiness as
the failed phase, so the original readiness-specific question is not yet certified.
Producer/runtime/control clocks remain distinct; adjacent timestamps are not paired
call durations. No Issue was created or reused; no further producer is selected.

### Task 37: Existing diagnostic event pipeline measured locally

The source audit recovered caller-retirement and offer-ownership paths without
identifying their historical issuer. It also found synchronous event publication:
runtime history append, control-client retained-history scan and browser-agent
notifications reaching the headless status renderer. The focused local profile uses
these actual owners and a local socket capture port. Four existing suites / 40 tests
passed before the sole measurement invocation. Its 60 fresh fixtures cover four
variants, three seed histories and five repetitions; four separate CPU-sampled
passes retain their instrumented timings separately. All 64 bursts preserve 500
ordered events, redaction and expected transport effects.

At seed history 10,000, control/agent/DOM median burst times are 106.3/110.7/132.0 ms,
with sample CV 1.38%/3.05%/1.85%; mapped `sendNewEvents` accounts for 230/299,
244/302 and 242/360 CPU self samples. Runtime seed-zero CV 16.11% stays noisy.
Later assertions record 1,000 agent/DOM notifications per burst; their synchronous
execution is a separate source fact. Timer quantization, broader CDP task timing,
unusable zero ScriptDuration and variable live-heap deltas remain explicit limits.
Network/server/native RTC, CSS/layout/paint, allocations and historical causality
are unmeasured. Generated profiles remain ignored; no product change, original
reread, optimization or E3 producer ran. First failed retention phase is still
unclassified. No Issue was created or reused.

### Task 38: Retained reporter headers do not identify a unique failed step

The existing ignored reader/test pair adds a finite retention-failure-phase
interpretation behind its canonical CLI and source/inventory guards. Genuine
semantic, provenance, membership, private-output, purpose, source-override and
function-boundary REDs precede the final 27-test GREEN. Original artifact source
62f067706 and actual docs-only inspection head d971 remain explicitly distinct;
11 tracked source owners match the artifact source, the installed reporter and
both locks/config remain hash-bound, and the helper/test pair has its own digests.
All three inventories, source markers, ZIPs and members verify before interpretation.

Root reviewed the complete source/test pair, patch, report, bindings and actual
validation chronology before the separate phase release. One execution per runner
passed with empty stdout/stderr and one fixed 212-byte row. All three report
headerAvailable false, operation unclassified and nullable cycle/frame facts.
The 88 original files / 5,980,973 bytes and all three archives remain byte-unchanged
after execution. Only the three retention logs / 48,250 bytes were interpreted;
no additional history, sidecar association, remote job log or producer was selected.

A bounded header-structure check then confirms one known retention failure header
and one error-detail line per runner, but zero step delimiters. The reporter can
omit a unique step when the recorded error-step tree has no eligible unique path;
one printed result error does not establish one errored step. The source audit
identifies possible conditions, not which occurred in these runs. Phase-start
markers and later health cannot supply the missing original operation.

The review also found a source-authentic formatting defect: the reporter leaves
one ASCII separator space on over-100-column headers with no rule bars. One new
effect-first assertion earned 27 PASS / one FAIL before the minimal regex fix,
then 28 PASS / zero FAIL; the no-step same-space control remains unclassified.
Root independently reviewed the complete amendment and formatter checks. That
post-execution correction does not create a second original execution or alter
the three preserved unknown outputs. Author/root separation and exact reused
unchanged-source reads remain disclosed. No product code, Issue or cause claim.

### Task 39: Recorded result error points through canonical readiness

The same ignored reader, purpose and CLI now expose finite failure-detail
availability/class separately from failed-step classification. A unique reconciled
retention result with one recognized known printed error marker before attachments
can retain exact allowlisted source-frame presence even when its step suffix is
absent. Optional async stack decoration changes no function/file/body bound.
Unknown or conflicting detail remains unavailable; arbitrary message/path/identity
text is omitted. Recognizable printed grammar does not certify a logical exception
count or complete reporter step history.

Three genuine missing-detail REDs preceded the initial 31-test GREEN. Closure
then earned a mixed unknown-class RED (30 PASS / one FAIL) and an assertion-label
RED (31 PASS / one FAIL); final 32 PASS preserves Expected/Received payload labels
without counting them as error classes. Root reviewed the complete delta, new
tests, before hashes, source ranges and every consequential raw validation log.
The unchanged fully reviewed owner/guard/CLI code is reused through exact hashes.
Explicit ignored-pair formatting checks passed; no production code changed.

A separately reviewed source/helper/test/inventory release executed once per
runner on the same three retention logs / 48,250 bytes. All three CLI calls passed
with empty stdout/stderr and one 271-byte row each. Each result records generic
Error plus reconnectFormationAgent, waitForCanonicalFormationReadiness and
Object.readiness frames. The connectFormationAgent frame is unavailable, which
does not establish whether that call ran. The known printed frames locate the
reported result error path; they do not identify the original failing step, the
specific readiness predicate, an application receipt or native/clock/lifetime cause.
All three keep headerAvailable false, operation unclassified and cycle null.

The 88 originals / 5,980,973 bytes and three archives remain byte-unchanged after
execution. Task 38's earlier outputs/releases/receipts remain preserved; Task 39
is a distinct reviewed interpretation rather than an unchanged reader rerun. No
additional history, sidecar association, job log, producer, optimization or Issue.

### Task 40: Readiness source trace and local reproduction selection

**Current outcome:** The read-only source audit and independent root review bind
39 source/test/config owners to runtime62 at inspection HEAD3f58. The harness
refreshes the exact room once, subtracts elapsed monotonic refresh time, issues a
fresh readiness command and polls its result. The browser observes accepted
layout/presence coverage and desired-peer readiness with subscription and terminal
cleanup safeguards; existing tests cover late peers, authority changes and
timeout/abort during cleanup. No missing-wakeup or native defect was earned.

Exhausted refresh can leave timeout0, which the formation decoder refuses; a
positive remaining budget below1000ms can lose to the adapter before the minimum
1000ms browser wait. Adapter cancellation races the running formation promise
without forwarding its signal to that browser waiter. These are source-reachable
boundaries, not an executed regression or an explanation of the retained failures.

Task 41 uses the existing memory three-browser script locally, with retention100,
all-scenarios unset and zero retries. Existing CI=1 startup disables service reuse;
the previously free API18080/SPA5177/control5180 ports are owned by this invocation.
Clean allowlisted OS inputs clear inherited database, ICE, cluster, credentials,
API profile and governed-attempt selectors. Unique ignored recorder/diagnostic
directories preserve this invocation's evidence. Installed Node26.10.0/Deno2.9.5/
Playwright1.61.1 and macOS arm64 differ from GitHub's Node24/Linux environment.
The existing JSON reporter supplements list steps; its recording cost remains a
diagnostic limit. This is one invocation with three browsers, rather than three
independent runners. No earlier full local B06 execution was recovered; the local
pipeline profile and test-list discovery were narrower checks.

### Task 41: Local B06 retention reproduction

**Current outcome:** One unchanged-source local diagnostic at inspection3f58/
runtime62 finished EXIT1 in634.695s. The default live matrix passed in85.671s;
all-scenarios was selector-skipped; retention failed in544.089s. Every result has
retry0, with no flaky or top-level reporter error. The existing JSON reporter
records one result error and one errored step: `retention-100 cycle 17: reconnect
peer C and wait for readiness`. Its generic Error contains a message beginning
RALLAR_BLACK_BOX_FORMATION_NOT_READY, rather than a reported generic adapter
timeout. This identifies the local failed operation; the old hosted failures
retain their separate unknown operation/cause. The intended100 cycles did not
complete, and no primary/repeat or successful E3 cohort is accepted.

The bounded309,123-byte later-health attachment already contains the producer's
canonical lifecycle projection. Root inspected only those existing finite values,
without re-reading the oversized recorder or adding a parser. Two projected
formation-readiness-rejected observations, at agent ordinals1 and3, record
roomTransportState idle, summaryAvailable true, roomOpen false, desiredPeerCount2,
readyPeerCount1 and hasDesiredPeers true. Their waitTerminalCause and association
with the first result error remain unknown. Separate later health records
settled2/2/2, ready1/2/1 and all connection timers false; it does not establish
the earlier rejection's native cause or terminal trigger. Checkpoints0/10, the
run summary, raw list/JSON result and failure evidence remain in unique ignored
local outputs. Raw result integrity and all39 unchanged source bindings were
verified after execution; owned API/SPA/control listeners were gone after normal
Playwright teardown. No retry, workload relaxation, source mutation or new remote
producer occurred.

Local Node26.10.0/Deno2.9.5/Chromium149.0.7827.55/Playwright1.61.1/macOS arm64
and the additional JSON reporter remain explicit fidelity limits. One invocation
does not replace three independent CI runners or governed B06 capture. The short/
exhausted-budget source candidates remain independent and unassigned to this
formation-not-ready failure; no correction or optimization is accepted from them.

### Task 42: Local connection and readiness discriminator

**Current outcome:** The read-only source trace binds32 unchanged source/test/
example owners to runtime62 at docs-only inspection64. Root separately inspected
only the existing309,123-byte projected failure-health attachment. Later current
session identities affirm that ordinals1 and3 desire each other but are ready only
to ordinal2; both configured lanes between1/3 are nonopen, while ordinal2's lanes
are open. The selected projected observations lie within the recorded cycle17
current-cycle-before-close interval. Two Offers return on1 and two Answers on3,
each with captured/current-PC true at its own record. Peer-timeout notifications
occur twice on1 and once on3; their current-at-notification snapshots show wrapper
Connecting/native new/ICE new. They do not pair native invocations, generations,
retired resources or deletion issuers. Deleted notifications are deferred and
re-read current facade state, so adjacent created/deleted rows are not a native
generation history. Producer/runtime/control clocks and recorder order retain
their separate meanings.

The canonical status owner suppresses accepted-layout eligibility after an
observed timeout/abort; it also requires accepted layout coverage of current
presence. Either path can produce captured idle before lane-count decisions.
The captured rejection does not retain desired/ready identities, lane or wait
status. Later formation retains accepted layout identity but drops current causal
revision, and is not an atomic captured wait snapshot. Thus the captured authority,
peer/lane and terminal discriminator remains unavailable. History is incomplete
with retained-prefix loss and six oversized rows; absence is not missing action.
All22 files in the initial inventory /40,145,497 bytes remain unchanged. Retained author
source analysis and root actual-value review remain separate after fresh-agent
dispatch failed at capacity. No test, causal regression, correction, optimization
or new producer follows; all baseline acceptance gates remain intact.

### Task 43: Published captured observations and locally accepted gate repair

The existing private controller captures the returned canonical room reason, lane
and cloned desired/ready peer identities before rereading a later live view. One
colocated sanitizer owns only those new facts; existing state/count capture and
projection stay in their owners. Invalid or missing facts remain null, with original
counts, explicit truncation and at most ten identities per list in original order,
including duplicates. The facts payload is bounded to 8192 actual UTF-8 JSON bytes;
that cap does not guarantee every complete envelope fits. A composed controller→
bridge→recorder→projector test separately verifies its actual row fits the unchanged
16384-byte limit. Upstream truncation survives repeated projection. Bounded append
preserves a short ready prefix beside the final desired prefix.

The initial semantic RED witnessed eight absent-field assertion failures with
84 passing controls; later byte/prefix assertions were reached in GREEN, rather
than retrospectively counted as RED. The asymmetric long-desired/short-ready
regression then witnessed one failure with 95 passing controls. Final formation/
projector tests pass 96; the combined headless check passes 97. Fix2's package-
boundary RED 3 PASS/1 FAIL earned only an erased fixture type correction; architecture
plus the pair passes 100, and maintained types enforce 1450 files with zero debt
or errors. Intermediate type, expectation and bundle failures remain preserved.

The published 3bd candidate measured 311543 Brotli bytes; its explicitly adjustable
headless allowance changed 304→305 KiB, leaving 777 bytes. The full unit run of
14374 PASS /12 SKIP/zero FAIL across 1479 passed/four skipped files belongs to
that source, rather than Fix3. Initial full-suite/type/expectation/bundle failures
and the unchanged isolated timeout recheck remain preserved. Both retained fix
reviews approved specification and quality; R1–R4 and the reverse import were
addressed. No fresh-reviewer context is claimed.

The published capture's required Branch Release 37241407870 failed seven static
changed-style findings. Its other executed release lanes and separate formation-
large/medium passes retain their own 3bd scope; they do not override that required
failure. Fix3 uses the existing strongly typed captured-facts representation and
existing projector JSON readers, with one canonical reason/identity/byte policy.
Full-list validation, independent unavailable lists, order/duplicates, upstream
truncation and the short ready prefix remain intact. This representation cleanup
earned actual style RED, not a fabricated semantic RED. Intermediate type/style
failures remain failures; the withdrawn omission-flag timing experiment is not
accepted as behavior-preserving because false/true encoded length can affect a
prefix at the byte boundary. The accepted version retains upfront omission timing.

Fix3's frozen local checks pass 97 focused tests, shared-test types, maintained
1450-file types with zero debt/errors, the native changed-style gate, nine Deno
roots, UI/headless builds and reachability (1752 files/1746 CI/six manual). Retained
independent specification review passed and quality was approved. No full unit
rerun was selected without a coverage gap. Final headless Brotli is 311682 bytes,
638 bytes below the unchanged 305 KiB allowance and 139 bytes above the 3bd
candidate; this is no measured runtime62 delta or performance improvement.
Fix3 is published at 48cb727. Required exact-source Branch Release, formation-large
and medium-scale are terminal PASS, including the required release lanes and
validation-evidence publication. Optional ALM failed with cause unclassified;
RTC observation integrity was skipped. These are correctness results, not E3
performance acceptance. The earlier 3bd static failure remains historical. Fixed
recorder/history/transport/workload caps, public RTC/readiness/native/clock policy
remain unchanged; Task 41 receives no retrofitted captured facts.

### Task 44: Local captured timeout and remaining readiness gap

One existing local memory three-browser diagnostic ran with a 100-cycle target,
zero retries and fresh owned services on unchanged published 3bd/tree8f source.
The report records default PASS, retention FAIL at cycle7 reconnect/readiness of
peer C, and one selector SKIP. The numeric npm child exit is unavailable: the
Python3.9 wrapper failed after waiting for the child because hashlib.file_digest
was unavailable. Wrapper EXIT1 is not the child's numeric status; no rerun occurred.
Nineteen original files /28,167,941 bytes are preserved, source stayed clean through
the run and the owned API/SPA/control ports were gone afterward.

One captured rejection on ordinal1 retains the canonical returned timeout reason,
reliable lane, desired2/ready1 and untruncated identity lists. Equality with later
current-session IDs associates the unready peer with ordinal3; that later-view
association does not establish native generation, first-error actor or exact
captured/error association. waitTerminalCause remains unknown. Retained history
has prefix loss and six oversized rows; absent rows are not absent actions.

During Task 44's limited-read phase, a single authenticated numeric-only query of
the 803367-byte report returned
ten repeated occurrences in 180 bytes, with one distinct decoded allowance:
56326.30595900002 ms, floored by the runtime to 56326 ms. Only the matched error
annotation has a nominal requested allowance of approximately 56.326 seconds.
That query alone did not establish actual elapsed wait, original command budget,
first actor, exact captured-rejection association or native cause. The proposed
snapshot reader was dormant, unimplemented and unselected; snapshot/JSONL contents
were unread at that checkpoint. Task 45's separately authorized original
correlations below supersede that limited-read boundary. Local macOS/Node26 versus
hosted Linux/Node24, extra reporter cost and
unestablished host idleness limit fidelity. This is diagnostic exercise, not the
full governed workflow or an accepted E3 primary/repeat.

During that limited-read phase, one authenticated bounded jq selection of the
existing later status records
observer1→current ordinal3 with connection/channel wrappers Connecting, native
connection/ICE new, native channel connecting, isOpen false and isReconnectable
false. Exactly one later peer/lane entry supports this current-session association;
it is not a captured deadline or generation view. Current-presence revision,
first actor, deadline coverage and native cause remain unavailable; prior prefix
loss and six oversized rows still apply. The unsupported address-space guard
failed before jq or original access; the final CPU/wall-guarded query exited0.
That guard provided no address-space guarantee. No raw recorder or snapshot
contents were read during that limited selection, and no further producer was
selected. The separately authorized Task 45 original correlation changes the
read scope, without repeating the producer or accepting a performance cohort.

### Task 45: Original correlation and measured SPA observer work

Authenticated original command/result, control-snapshot, later-health and
6,398-row event correlations supersede Task 44's bounded-only inspection scope.
A failed after 56,838 ms and C after 46,272 ms, while B passed after 10,984 ms. Both
failed agents captured timeout/desired2-ready1 with B their ready peer; all adopted
accepted layout covering current presence. Captured idle is timeout suppression,
not proof of removed authority. One current-PC Answer was rejected for Offer
mismatch; the next three matching Answers completed remote-description application.
General missing Answer/application and stale-layout explanations do not fit those
positive facts. Missing rows still do not certify absent actions or complete history.

Pair-qualified timeouts/replacements and source ownership show that C answers a
reused Offer before its retained peer expires, with no intervening peer creation.
The service starts establishment timing at creation; reused Offers do not renew
it. Closing that answering peer invalidates the recovery pairing. This explains
later failed recovery, not the initial stall and not authority to extend a timer.
The first A timeout had descriptions present, stable signaling, ICE connected and
native connection/channel connecting. Original DTLS/SCTP transport state and native
candidate/generation association remain unavailable; native controls do not make
retained reuse alone a sufficient explanation.

An owned Chromium experiment mounted the actual SPA without API/RTC/control work
and seeded 2,136 retained original events. It uses the full-stack runner’s local
Vite dev/StrictMode rendering; these costs do not establish production-build cost. Three UI-enabled next-turn delays were
116.8/122.9/150.0 ms versus 4.3/4.3/4.5 ms with only UI subscribers suspended;
immediate recordEvent remained 0–0.1 ms. Hidden ReportPanel redaction/serialization,
inactive trace/event history processing and timestamp formatting dominate sampled
presentation work. This is a measured scheduled React observer cost, not headless
renderer or sink self-time, a subscription leak, governed B06 measurement or proof
that UI delay alone caused the connection failure. Same-agent original continuation
gaps also grow with retained history; they include scheduling and establish no
cross-agent one-way latency or particular AL delivery. Original integrity and
separate retained independent native/formation reviews remain disclosed. No RTC
policy, retry, timeout, workload or acceptance threshold is relaxed.

**Next action 1:** Design and implement semantic TDD for observer presentation:
closed reports and inactive evidence panels perform no whole-history presentation
work, while recorder/artifact contents and visible UI disclosure remain intact.
Apply recursive touched-file/legacy closure and independent task review before
acceptance. The allocation-throw retry proposal remains a separate source-backed correctness
candidate; Task 46 records its scope, necessity and unexecuted regression.

**Next action 2:** After implementation and independent review, complete required
correctness checks before accepting the correction. Then select only a qualified
exact-source RTC diagnostic that discriminates the unresolved native stage. No automatic producer or baseline
capture is selected; native cause and full E3 acceptance remain unproven.

Full B01–B06 accepted primaries and all required repeats, relevant E1
recovery/reconciliation after representative E3 succeeds, homogeneous noise
handling/comparison, ranking and human follow-up/no-optimization acceptance remain.
E3 has zero accepted cohorts; historical cause/native lifetime/application/issuer
remain unknown. E4 stays conditional to the exact candidate, B07 held. Failed
diagnostic preservation satisfies none of those baseline completion gates.

### Task 46: Retry proposal necessity assessed from current code

**Proposal:** Restore a truthful retryable lane state if synchronous initiator
`createDataChannel()` throws before returning a native handle. The next existing
`ensurePeerConnectionStarted()` call may then retry that lane on the same live,
admitted peer. This is failure cleanup at the canonical channel owner, not a new
automatic retry loop or a broader connection policy.

**Proven from current source:**
[QRtcDataChannel.connect](../../../packages/shared/webrtc/qrtc-data-channel.ts)
sets `Connecting` and registers its peer callback before native allocation. A
throw leaves no assigned channel and no rollback. Its readiness guard excludes
`Connecting`. The live-peer reuse path in
[WebRtcConnectionService](../../../packages/shared/services/web-rtc-connection-service.ts)
therefore suppresses the next lane start. With another reconnectable lane, the
service may enter its start loop, but the failed lane's own guard still skips it.
A later incoming channel, explicit reset/removal or establishment timeout may
change the state; none implements the promised next-ensure repair. The existing
service test injects permanent allocation failure and checks only the first
setup-in-flight result. No one-shot recovery regression has been executed yet.

**Is it needed?** A narrow exception-recovery correction is justified by the
owner's existing lane-repair contract. Earn it with one semantic RED before
implementation: fail native allocation once through the existing fixture,
ensure again, observe a real lane on the same native peer, then open it and
observe public readiness. Verify that native setup count and consumed attempt
budget do not increase. Keep normal receivers awaiting an incoming channel and
initiators with an actual connecting channel unchanged; neither may allocate a
duplicate. Retire only the failed lane's owned registration, preserve the
original direct-call Error and sibling/consumer subscriptions, and complete
rollback before reentrant callbacks. A later callback-configuration failure with
an allocated handle is a separate variant and needs its own evidence.

**Relevance to the latest failure:** This proposal is not required by the
captured channel-present, stable-signaling, ICE-connected initial stall, and no
allocation exception is established for that stall. It cannot be presented as
its root-cause fix or as a way to accept E3. Original browser occurrence and
frequency of the allocation path remain unmeasured. Keep it a separately scoped
correctness candidate after the active observer correction; the current
assessment authorizes notes, not retry implementation.

**Separate policy question:** Retained responder expiry is a source-backed
reason later recovery pairing fails: a replacement Offer can be answered on an
older native peer whose original establishment deadline then expires. Renewing
that deadline, increasing attempts, adding backoff or forcing replacement is a
different proposal. Task 45's native controls show that retained reuse alone can
open successfully; the initial native stage remains unresolved. No such policy
change is currently justified or selected. A decision needs a pair/generation-
bound failing negotiation and a semantic test showing why the existing bounded
lifetime is incorrect, while preserving exhaustion and malformed/admission
fences.

**Existing retry ownership:** Outbound reconciliation reuses a live native peer
and starts only reconnectable lanes; terminal peers are removed before fresh
admission. A new native setup consumes the per-peer attempt budget. Native close
or establishment expiry does not refund it; establishment clears it. When the
enabled count or duration limit is exhausted, new setup is refused until its
cooldown expires. The budget does not schedule a new attempt itself. Preserve
those boundaries; allocation cleanup on a retained peer spends no additional
native setup attempt. Existing AL consumer redelivery is a distinct signaling
boundary, not this lane-allocation proposal.

No retry code, timer, workload, recorder or acceptance change is made by this
assessment. Semantic RED/GREEN, native browser occurrence and a policy-changing
experiment remain unexecuted. E3 still has zero accepted cohorts; all B01–B06
baseline completion gates and B07's hold remain intact.

### Task 47: Observer presentation correction independently reviewed

**Source and review:** Observer implementation at 65b257ab6 is followed by the
separate test/support fix at `9db431d2cae002e1867aa9e5149ae603fc7675df`.
Initial independent review required closure fixes; scoped re-review approves all
Important and mechanical findings, with no actionable residuals.
PR #633 remains the draft delivery entity. Required hosted checks for the new
source have not yet been accepted. This completes implementation of Task 45's
first next action and its independent review at the checked local scope,
without completing the RTC baseline.

**Behavior:** Report Snapshot checks disclosure and truthful workbench activity
before snapshot construction, retained-history traversal, redaction or JSON
serialization. Inactive Trace and Event Stream preserve their filter/window
owners but stop event-history presentation. Advanced retains Workbench/Manual
controls and drafts while constructing Manual's stateless inbox/history only
when truly active. Show/reactivation exposes current complete redacted values;
Hide/inactivation stops that work. Recorder/artifact histories remain complete.
Other existing bounded/current hidden displays are outside the measured
whole-event-history correction; no claim that all hidden UI work disappeared.

**TDD and validation:** Five meaningful initial semantic assertion REDs preceded
production edits. The stronger inactive-Advanced whole-entry assertion then
caught remaining Manual traversal (expected zero, received two) before its owner
was corrected. Semantic GREEN and real visible controls prove suppression,
privacy, complete current recordings and retained drafts/filters/disclosure.
The covering six-file run passed 30 tests; the affected app suite passed all
1,917 tests in 189 files; five browser workflows passed. Later test-only fixture
closure passed 19 focused tests and a compiler check of the actual test modules.
Final removal of an unused internal export passed 13 lifecycle/bundle tests,
app typecheck/build and the actual chunk verifier CLI against real output.
The broad app/browser runs retain their exercised source; they were not repeated
for the focused fixture/export changes or obsolete test retirement. Fix1 passed
24 covering tests, then 15 lifecycle/mode tests and the final three mode checks;
actual fixture modules compile with the precise ES2024 test API. The useful
configuration-preservation requirement now invokes real public store actions and
expects independent command/event inputs plus prior evidence copied before the
action. These consumer checks cover the narrow changes.

**Closure and limitations:** Every changed human-authored file and recursively
changed support file was reviewed in full; independent untouched code remains
outside. Initial review exposed obsolete monolithic-app test fallbacks and
private source-string assertions missed by comparison tooling. Fix1 deletes them,
keeps useful public mode/dependency rules, and relies on existing executable
bundle/CLI leak coverage. No temporary annotation excuses an obsolete test.
Named fixture output and import-shape findings are also corrected.
Canonical owners replace affected predecessor filenames without aliases.
Full typed fixtures replace sparse double casts; the manifest/JSON boundaries
are explicit. An unused internal FailurePanel forwarding export was removed
after verifying direct canonical consumers. Changed-style comparison passes;
reviewed callback-depth observations remain in touched tests, with visible
registration/interaction ownership; other reported repository/directory warnings
belong to independent untouched owners.
The initial style failure and browser workspace/selector/ingress-redaction fixture
failures are retained with the later passing checks. An attempted extra browser
preservation assertion failed because simulated first-opening intentionally starts
Replay Sample and resets its history; it was removed and replaced with the actual
configuration-action test. It is not a production failure or semantic RED.
Fixture matcher/compiler and tool-root setup failures are also disclosed.
Node localStorage/color and
large-bundle warnings remain disclosed. No retained legacy exception, migration
bridge, public/wire change, duplicate history, RTC retry/timer/policy change,
new producer or Issue was introduced.

**Evidence meaning:** There is no comparable fresh timing measurement: the original
SPA result/profile is retained, but its executable protocol was not saved.
Zero-hidden-history semantic proof establishes this correction, not a quantified
whole-SPA speedup. Task 45's original report and findings remain unchanged:
measured observer overhead; retained responder expiry invalidating later recovery;
and unresolved initial ICE-connected/native-and-channel-connecting stall.
Task 46's allocation-exception repair remains an independent, unimplemented
candidate. E3 still has zero accepted cohorts; all baseline gates remain.

**Next action 1:** After required correctness acceptance, audit the existing native observation owners against the missing first-stall
DTLS/SCTP transport and native/candidate-generation association. Specify the
smallest discriminating evidence boundary with truthful unavailable values and
exact source/pair identity. Do not infer a cause from already applied Answers,
current layout adoption or UI suppression.

**Next action 2:** Only if that audit proves missing observation, implement its
bounded semantic TDD correction and independently review it. Select any later
exact-source diagnostic explicitly, preserving the accepted workload, attempt
accounting and first failure. No automatic E3 run, retry implementation or deadline
renewal is selected. Accepted B01–B06 primaries/repeats, E1 recovery/reconciliation,
homogeneous noise handling, ranking and human acceptance remain outstanding;
B07 stays held and E4 stays conditional to the exact candidate.

### Task 48: Hosted correctness failures and test-consumer correction

**Hosted outcome:** Branch Release run 37282459228/attempt 1 tested exact source
`ac3f5d95f46ef381d577a23fdee79cfc8f03cfea` and is terminal FAILURE. Static job
111674134576 and Recipe Console browser shard 1/2 job 111674134642 failed.
The executed unit, tooling, Deno, app-browser, Recipe Console shard 2/2, API,
PostgreSQL integration and ALM release lanes passed; observation integrity and
validation-evidence publication were skipped. Separate formation-large and
medium-scale/fairness checks passed, as did governance and CodeQL. Those passes
do not override the required release failures or establish performance acceptance.
PR #633 remains draft, OPEN and MERGEABLE.

**Static cause:** The exact changed-range coupling check against trusted base
54adf4dd191c7102092b1bae4f9b3f77d943a8e1 rejects unclassified candidate
`test-structure-coupling-ea2af8a6ac2fd5e9` in
`packages/tests/rallar-black-box/rallar-mode-boundary.test.ts`. The touched test
enumerates production `*-actions.ts` files and requires each to be reachable from
fixed tab-group files. Inlining a predecessor helper exposed this existing source
inventory to the detector. The gate is working as intended; moving the inventory
back behind a helper or registering an incidental filename requirement would not
correct the test. The remaining private identifier/import-spelling assertion also
needs full-file review against independently useful behavior. Changed-style
comparison passed and was not the failing command.

**Browser cause:** The sole shard failure is the case
`opens every registered legacy surface from its alias and contextual route`,
at `runner.runs: target chunk` (expected true, received false). Its table pins
`RunnerRunsPanel`, while the canonical production lazy import now loads
`runner-runs-panel.tsx`; the existing local production manifest corroborates its
kebab-case asset. The case-sensitive matcher cannot match the predecessor name.
The outer Runs wrapper was visible before this assertion, but it encloses Suspense
and does not prove settled child content. Later unrelated-loading and polling-
shutdown assertions were not reached for Runs. The shard finished one failed,
nine skipped and 108 passed. Hosted trace paths were printed but no browser trace
was uploaded; local manifest evidence is not a recovered hosted request trace.
The static and browser failures have separate commands, files and causes.

**Correction and local evidence:** The three test/support owners are corrected in
commit `ab64b7822d4b79e5a534916d60b0b0877b3aa627`. The mode test retires both
the production file inventory and private AST/identifier assumptions while keeping
public mode and evidence-preservation checks. Advanced derives emitted assets
from actual dynamic manifest entries and awaits each selected child's visible
heading. Deferred loading and unrelated asset absence remain checked. The retained
Runs post-unmount request assertion passes locally but initial review finds its
fixture/counter vacuous, so that shutdown proof is not accepted. Private timer
inventories give way to positive control
request counts and unchanged counts over 5,500 ms after leaving the experience;
these are request observations, not a separately counted active periodic cycle.
Canonical decoding exposed three missing mandatory group-assertion counters in
the shared Monitor fixture; explicit zeros match its empty assertion manifest.
Its mutable routing state is owned by one fixture class with pure snapshot
builders and bound detached counter readers. No production owner changes.

The focused local browser RED reproduces the hosted Runs assertion; its retained
trace records the canonical production asset returned HTTP 200 and the Runs child
heading settled without a loading fallback. The malformed fixture then failed
canonical decoding, and an initial class version failed detached callback access;
both introduced closure failures remain recorded with their later corrections.
Command-selection, compiler-selection and intermediate changed-style failures
also remain disclosed. These do not become original RTC causes or semantic REDs
for a production change.

Local validation passes 17 focused unit tests, the visible direct-only simulated
WebSocket case, and the eight-file shared-fixture consumer browser run: 69 passed,
one opt-in live full-stack case skipped. That covering run preceded only the final
erased response-type annotation/import and removal of its type assertion; actual
fixture compilation passed afterward. App and maintained-test typechecks pass;
maintained tests enforce 1,451 files with zero debt/errors. Scoped formatting,
whitespace, changed-style and structure checks pass. Exact-file human review
disposes of advisory cognitive/cohesion/framework callback signals; the three
structure advisories belong to independent earlier branch owners. Environment/
large-bundle warnings remain disclosed, without pristine-output claims.
The exact trusted-base 54adf4dd191c7102092b1bae4f9b3f77d943a8e1 to committed
ab64b7822 coupling gate exits zero with no current candidates and complete/current
classification evidence. Local passes do not relabel the ac3f5d95 hosted failure,
dispose of independent review findings or establish fresh hosted acceptance.

**Initial independent review:** Specification and quality both require changes.
The original inventory/asset fixes, typed boundaries and coherent fixture state
ownership are sound. Runs receives an empty distributed-run list, so the selected-
nonterminal-run polling guard never starts its effect. Its assertion counts the
`/runs` collection, while that effect refreshes `/distributed-runs` and a selected
`/runs/<id>`. A quiet unrelated counter cannot prove shutdown. Fix1 must establish
a selected nonterminal run, observe a positive automatic request cycle on the
real analysis endpoints, then verify quiet after leaving Runs over the existing
cadence window. Separate Recipe Console recurrence already has public coverage;
no duplicate default-experience assertion is needed for that concern.

The fixture's four `set...` methods also advance revision; two additionally
calculate reconnect count or normalize event count. Current setter vocabulary
requires validation/assignment without hidden computation. Fix1 names those
transitions truthfully, preserves response/event/revision behavior and updates
the verified Monitor/responsive consumers with recursive full-file closure.
No old-name alias, second fixture owner, registry exception or production timer
change is selected. The initial REQUEST_CHANGES verdict remains part of the
history; the following fix1 evidence addresses it without relabeling earlier runs.

**Fix1 source and semantic evidence:** Commit
`c62dd5b5cd6ecb5704509eab0dbfa9e8f677788c` changes the Advanced case, existing
Monitor fixture and its Monitor/responsive consumers. Before seeding the fixture,
the strengthened mounted automatic-cycle assertion fails meaningfully: the
settled `/distributed-runs` count stays at one over 7,000 ms. Existing fixture
data now selects a running nonterminal distributed run. The first seeded pass
exposes a selected-detail HTTP 404 despite quiet/active collection evidence;
requiring HTTP 200 earns a second fixture RED. The existing adapter then serves
that selected record from its canonical current snapshot. Deleted records still
return 404, consistent with the list. Intermediate selector/setup failures and
the HTTP-404 pass remain recorded; neither is a production RTC RED.

The final focused real-browser case passes at the exact final runtime source.
For `/distributed-runs`, `/distributed-runs/monitor-distributed-live` and
`/runs/monitor-control-live`, request-start counts move from settled 1/0/1 to
automatic active 2/1/2, then stay 2/1/2 after unmount and 5,500 ms of quiet.
All five analysis responses return HTTP 200. Collection cycles are 1,042 ms apart,
against the existing 1,000 ms polling cadence; the quiet interval covers multiple
cycles. No click or manual refresh intervenes in the automatic-cycle proof.
All ten lazy-target asset, settled-child, alias, draft and unmount checks are
reached. This establishes test-owner polling/shutdown behavior, not RTC recovery
or performance acceptance.

The fixture operations are now `transitionRunState`,
`transitionSingleAgentFailure`, `transitionFailureAgentConnection` and
`resizeAdditionalEventWindow`. Revision, reconnect, normalized event-count and
response behavior remain verified, with no predecessor aliases. Recursive
Monitor closure uses an owned typed browser gate and explicit DOM evidence
decoding; responsive geometry has a named complete output contract. There are
no production, REST-contract, polling-timer or native-lifetime changes.

Fix1 validation passes the focused Runs case and 25 Monitor/responsive browser
cases, with one opt-in live case skipped. The 25-case run exercises transition
renames and Monitor closure before the final erased responsive bounds annotation,
selected-detail adapter and Advanced endpoint assertions; the latter runtime
changes have the later focused Runs pass and snapshot parity evidence. The final
four-owner fixture compiler, app typecheck and 1,451-file maintained-test typecheck
pass with zero debt/errors. Thirty-seven parity probe outcomes/revisions agree;
selected detail equals its canonical list record and deleted detail returns 404.
Formatting, whitespace, changed-style and structure checks pass with disclosed
advisory dispositions and the same three unrelated structure advisories. The
immutable trusted-base 54adf4dd191c7102092b1bae4f9b3f77d943a8e1 to c62dd5b5c
coupling gate passes with no current candidates and complete/current registry
evidence.

**Scoped independent re-review:** Specification APPROVE and quality APPROVE on
exact c62dd5b5c; both original Important findings are resolved. All four changed
owners were read completely, including recursively touched Monitor/responsive
consumers. Immutable snapshots match the committed source. Direct archive checks
confirm the first semantic RED's assertion-only source delta and the final GREEN's
exact committed Advanced bytes, canonical selected-record equality, five HTTP-200
responses and the three-endpoint growth/quiet attachments. The unchanged mode
owner retains its initial accepted assessment. The reviewer repeated no suites;
validation source qualifications, warnings and live skip remain disclosed.
No further source correction is requested. Publication and fresh required hosted
acceptance were pending at that review checkpoint; the following exact-source
evidence closes that prerequisite.

**Fresh hosted correctness acceptance:** Reviewed correction c62dd5b5c and the
plan update are published at `92a6261a1522b3f40e7171da8f41dd7e369ea0c3`, tree
`4efffbf4a97ba80576e3ee6d83356255d0aab868`. Branch Release run
[37306934111](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37306934111),
attempt 1, is terminal SUCCESS; required aggregate job 111756813393 is SUCCESS.
All 16 executed jobs pass, including static, main/tooling unit, Deno, app browser,
both Recipe Console shards, standard/cluster API recipes, Postgres integration,
ALM and validation-evidence publication. RTC observation integrity is SKIPPED.
CodeQL passes. Retained logs verify release checkout 92a6261 and the exact
coupling range from trusted base 54adf4dd191c7102092b1bae4f9b3f77d943a8e1:
no current candidates, complete classifications and complete/current registry.
Recipe Console shard 1 has 109 passed, 9 skipped and no failures; its dot reporter
supplies no per-case hosted trace. Local named-case trace evidence keeps its scope.
The downloaded validation record passes its canonical validator and matches
the immutable local build-tree digest. Initial live-run log retrieval was
unavailable; retrieval of the same jobs succeeds after terminal completion,
without a producer restart or retry.

Independent uploaded-artifact audits accept unchanged native
[formation](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37306933782)
and [medium](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37306933776)
correctness, both attempt 1: 4+12 and 1+12 cases pass with no required skips or
blocking failures. All 29 source-expanded recipes and complete result indexes
reconcile with their bounded reports. Formation's 158 explicitly nonblocking
observations stay accounted; its final blocking assertions pass. Both fairness
fixture proofs match raw events and establish recovery/not-before behavior,
without proving natural fairness contention. Managed formation establishes
ACTIVE/activated, without separately asserting descriptive observedRate=1.
Both runtime stamps identify synthetic merge
`2d63c3f316326941e6775a9c4a46ba0e7e9e9a06`, with parents base 54adf4dd and feature
92a6261, and tree exactly equal to published 4efffbf4. Archive digests/extracted
bytes are verified; workflow head metadata is not substituted for runtime SHA.
These correctness scopes neither quantify the observer improvement nor resolve
the initial native stall, and they accept no E3 performance cohort.

**Protected diagnosis:** Task 45's original report and findings remain unchanged:
the measured observer cost at 2,136 events; the older responder connection's
creation-time expiry breaking a replacement negotiation; and the unresolved
initial ICE-connected/native-and-channel-connecting stall. Applied matching
Answers and adopted current layout narrow that stall without identifying its
DTLS/SCTP or native/candidate generation. The implemented history suppression is
algorithmically verified, without a comparable fresh timing result. Task 46's
allocation-exception rollback remains a separate unimplemented candidate; these
test failures justify no retry or establishment-deadline policy change.

**Handoff action 1 (completed by Task 49):** Complete the bounded read-only native observation audit
for first-stall DTLS/SCTP transport and native/candidate-generation association,
with truthful unavailable values and exact source/pair identity. Trace capture,
ordering, privacy, projection and existing semantic coverage before proposing a
correction. Preserve the original diagnosis and failure history; ab64b7822,
c62dd5b5c and published 92a6261 checks retain their distinct scopes.

**Handoff action 2 (current design slice):** Review the proved observation gaps' compatibility, privacy and
ordering obligations, then select its bounded design and semantic RED before
production implementation and independent task review. No compatibility asset,
registry waiver, retry policy or establishment-deadline renewal is selected.
No automatic E3 run follows.
E3 still has zero accepted cohorts; B01–B06 primary/repeat acceptance, E1 recovery/
reconciliation after representative E3, noise/comparison, ranking and human
acceptance remain outstanding. B07 stays held; E4 remains conditional. No Issue
was created or reused.

### Task 49: Native observation gaps independently audited

**Outcome:** A read-only audit of published 92a6261 and its exact source blobs
has independent specification APPROVE and evidence-quality APPROVE, with no
actionable report findings. Existing owner, translation, recorder, projection
and test paths were traced; no production change, semantic suite or producer
ran for this audit. Approval covers the audit, not a new public contract or
performance acceptance.

**Proved gaps:** The native owners fence exact PC/channel objects internally,
but published observations lack their lifetime identity. Current status omits
DTLS/SCTP transitions and the first typed native transport error; channel error
clears its native handle before lifecycle notification. Candidate application
preserves nullable usernameFragment, but diagnostics cannot associate individual
applications with a proved ICE generation. Offer/retry identity is not that
generation, and ICE has no wire offerId. The service already captures original
setup/timeout facts before removal; the facade drops those arguments and samples
deletion after teardown. Setup-start epoch is not the watchdog's scheduling
time or a monotonic deadline. Later asynchronous stats can join retired native
state and use a first-qualifying-pair heuristic rather than transport linkage.

**Evidence boundaries:** JSONL preserves produced facts; later sequential health
reads cannot recreate the first failure. The finite artifact projection would
drop new keys. Readiness facts' 8,192-byte limit remains distinct from recorder
and retention limits. Raw SDP, ICE credentials/fragments, certificates and
unrestricted native error text must remain unpublished. Standard transport APIs
do not prove target Chromium availability; missing, unsupported, failed or
retired readouts must stay explicitly unknown/unavailable. Existing fakes offer
transport seams, but state mutation alone does not dispatch a transport event.
New instrumentation must preserve handlers, deadlines and sink-failure isolation,
bound synchronous work and avoid getStats in hot native callbacks.

**Diagnosis and retry assessment retained:** Task 45's 117–150 ms observer delay
at 2,136 events versus about 4 ms UI-off remains the measured performance finding.
Original retained-responder expiry breaks later recovery pairing; applied matching
Answers, adopted layout and B becoming ready narrow the A–C failure. Neither
finding establishes the initial post-ICE native/channel stall. Task 46's failed
allocation rollback is a separate source-backed candidate awaiting a recovery
RED, with no captured allocation exception in the channel-present B06 stall.
It supplies no reason to expand retries or renew the establishment deadline.
Task 47's suppression has correctness evidence, without comparable current timing.

**Next action 1:** Design the minimum safe owner-captured lifetime/DTLS/SCTP/
typed-error, proved candidate-association and timeout/termination evidence, then
implement test-first in the canonical owners with independent task review.
Semantic RED must distinguish original and replacement objects, preserve causal
facts through teardown, retain truthful unknowns/private-payload exclusion and
prove observation failure leaves business outcomes unchanged. Inspect existing
tests before adding coverage. Review public diagnostic outputs and consumers
separately from required inputs/wire contracts; the existing clock approval
authorizes no new compatibility decision. Select focused owner/projection tests,
affected package typechecks and public API/bundle checks if exports change.

**Next action 2:** After design, implementation and focused correctness acceptance,
select one comparable observation/timing exercise explicitly, with immutable
runtime/source identity, actual target API availability, first-stall capture and
observer perturbation assessed together. No automatic E3 run follows this audit.
E3 remains zero accepted cohorts; E1 reconciliation and the full B01–B06 gates
remain outstanding, E4 conditional and B07 held. No Issue was created or reused.

### Task 50: Original-owner observation proposal reviewed; human approval pending

**Outcome:** The corrected architectural proposal has independent design/specification
APPROVE and quality APPROVE. The first review required four finite corrections;
scoped re-review resolves all four with no introduced blocker. This is proposal
review, not human compatibility approval, a final specification/implementation plan,
semantic execution or performance acceptance. No code, service or producer changed.

**Proposed ownership:** One optional concrete `RtcNativeObservationScope` is completed
before the service/native graph. Its nonce source runs once at composition; local
kind-qualified monotonic allocation then invokes no external allocator. Service,
PC and channel owners share admission and keep their original capture/cleanup
authority. Browser initialization handoffs and shutdown have named diagnostic-only
disposal ownership; no native rollback, watchdog renewal or retry change is selected.
Pure finite translation feeds the existing diagnostic stream and recorder.

**Finite policy and honest output:** Proposed admission caps are 256 setups,
256 native PCs and 1,024 native channels per scope: 1,536 lifetime tokens.
Each admitted setup reserves timeout and termination; each admitted PC/channel
reserves one final snapshot with its first/typed-error summaries. This gives
1,792 terminal attempts, plus 4,096 ordinary, two status and one scope-limit
attempt: at most 5,891 new attempts. The proposed source data cap is 8,192 UTF-8
bytes; existing formation/artifact/read/row/retention limits stay unchanged.
Oversized source data uses a same-slot unavailable replacement, without a no-error
claim. These are proposed policy limits, not measured capacity or overhead.

Retention100 keeps A/B service scopes alive while C reconnects. Nominal two-lane
composition gives each surviving agent 102 PC/setup and 204 channel lifetimes;
102 is not an upper bound on retries/replacements. Ordinary history can exhaust
while admitted later lifetimes retain final entitlements. Unadmitted lifetimes,
scope disposal, missing delivery and artifact eviction remain explicitly partial
or unavailable; bounded publication attempts do not guarantee retained history.

Mandatory JSON error states distinguish observed, none-observed within an actual
window and unavailable. Missing/malformed fields cannot become no-error evidence.
A generic channel error ends that channel's handler window; later detached events
cannot fabricate typed evidence or mutate a replacement. A genuinely live parent
transport or replacement channel retains its own exact source identity. Candidate
operation/index and bounded data-ICE fragment equality do not prove target transport
or ICE generation; both associations remain unknown, with raw fragments private.

**Next gate:** Human design approval remains pending. Only after the architectural
specification/plan prerequisites may semantic TDD and independent implementation
review proceed. Target API availability, sufficient first-stall capture, maximum-shape
serialization and observer perturbation are unexecuted validation questions.
Task 45's measured observer delay and confirmed recovery expiry remain distinct
from the unknown initial post-ICE trigger. Task 46 is separate and unimplemented;
E3 has zero accepted cohorts, E1/full B01–B06 acceptance remains outstanding,
E4 conditional and B07 held. No Issue was created or reused.

### Task 51: Approved configurable RTC establishment diagnostics amendment

**Human direction:** “Approved. Implement when plan ready.” The user requires
configuration through the UI and GitHub Actions, including distributed recipes and
recipes generally. The selected modes are Off, Signaling and Full native. This is
execution authorization after specification/plan readiness, not a new measurement
or completion claim. No repeated generic approval gate is required.

**Specification:** [RTC establishment diagnostics](../../../plans/active/rtc-establishment-diagnostics.md)
combines Task 50's reviewed original-owner native contract with this configuration
amendment. Core owns one canonical mode vocabulary; browser composition applies it
once. Shared-test owns executable recipe/run provenance and per-agent receipts.
Run override wins over step, recipe, host and product default; explicit Off survives.
SDK without an RTC sink defaults Off, with a signaling sink defaults Signaling;
Full native is explicit. Existing connection scopes are immutable, and incompatible
reuse reports the need for an explicit new connection without automatic reconnect.

**Source refresh:** SDK/decoder/fingerprint/persistence projections currently omit
capture selection. Generic recipe records can silently lose unknown properties at
browser decoding. Spawned/external/mixed/no-spawn agent paths have distinct inputs;
requested metadata does not prove application. B06's resolved configuration and
homogeneous comparison must include the selected and proven applied mode. The
standalone headless lifecycle workflow keeps its existing 25 inputs; connection
selection belongs to the distributed run workflow and recipe commands after launch,
with host CLI/environment/query defaults. No input removal or cap increase is selected.

**Readiness:** Independent specification and implementation-plan review APPROVE after
three finite corrections: restore canonical fields lost by Markdown formatting,
represent expected parser/reuse failures as typed results, and witness initial
semantic RED through the existing initializer before importing new helpers. The
human authorization is satisfied; implementation proceeds without another permission gate.

**Implementation and acceptance:** Tasks 52 and 53 are the only concrete implementation
horizon. Later recipe/UI/agent/CI/B06 outcomes remain required. Every changed
human-authored file is reviewed and remediated in full; every support file changed
by remediation enters closure recursively; independent untouched code stays outside.
Use witnessed semantic RED/GREEN and independently review each slice. No legacy
alias/migration/config registry, second recorder, hot listener switch, new getStats
polling, retry/allocation rollback, watchdog renewal or automatic producer is selected.

**Protected diagnosis:** Task 45's original Vite-dev/StrictMode experiment measured
117–150 ms continuation delay versus about 4 ms at 2,136 events with UI subscribers
suspended. Production/post-fix timing is unmeasured. Retained-peer establishment
expiry invalidates later recovery pairing; matching Answers/current layout/B-ready
are confirmed correlations. The initial post-ICE native/channel trigger remains
UNKNOWN. Task 46 remains independent and unimplemented. E3 has zero accepted
cohorts, E1/full B01–B06 acceptance remains outstanding, E4 conditional, B07 held.
No GitHub Issue was created or reused.

### Task 52: Immutable SDK capture selection and truthful construction readback

**Deliverable:** Off and Signaling control the actual constructed RTC capability;
Full native requests report unavailable/unsupported until Task 53. Desired defaults
cannot alter an active/pending connection or masquerade as its applied receipt.
This is a usable SDK configuration boundary, not final amended acceptance.

**Files:**

- Modify `packages/shared/webrtc/rtc-signaling-diagnostics.ts`: canonical
  `CaptureMode`, `CaptureOrigin`, `CaptureConfiguration`, `Readout`,
  `CaptureApplication` and `CaptureReceipt` from the specification.
- Create `packages/shared/webrtc/rtc-capture-configuration.ts`: pure parsing and
  precedence resolution, shared by later adapters.
- Create `packages/shared-web/browser/rtc/create-browser-rtc-capture.ts`:
  construct the selected capability plus truthful receipt at one effect boundary.
- Modify `packages/shared-web/browser/rallar-connection-facade.ts`,
  `rallar-operation-options.ts`, `composition/browser-facade-runtime-state.ts`,
  `session/session-auth-lifecycle.ts`, `session/session-connection-lifecycle.ts`,
  `session/rallar-startup-controller.ts`, `session/session-connection-operations.ts`,
  `connection/browser-transport-runtime.ts`, `connection/initialise-browser-middleware.ts`
  and `rtc/initialise-browser-rtc-runtime.ts`: preserve defaults/operations,
  construct once, enforce immutable reuse and expose actual readback.
- Create `packages/shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts`:
  typed public incompatibility error; export through the existing browser entry.
- Test `packages/tests/shared/webrtc/rtc-capture-configuration.test.ts`,
  `packages/tests/shared-web/rtc/browser-rtc-capture.test.ts`,
  `packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts`,
  `packages/tests/shared-web/session/browser-auth-session-contract.test.ts`,
  `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`, and
  `packages/tests/shared-web/connection/browser-rtc-capture-reuse.test.ts`.
  Existing initializer/transport test consumers enter closure when changed.

**Interfaces:**

- `parseRtcCaptureMode(value: unknown): Either<readonly RtcCaptureModeValidationIssue[], ParsedRtcCaptureMode>`
  uses the existing `packages/shared/resilience/Either.ts`. `ParsedRtcCaptureMode`
  has required readonly `mode: RtcSignalingDiagnostics.CaptureMode | undefined`;
  only undefined is omitted. Invalid supplied values return named issues with
  `code: 'invalid-rtc-capture-mode'` and `message: string`, never the raw value.
  Omitted success is `{ mode: undefined }`, never `Either.ofRight(undefined)`.
  Adapters map their empty/Inherit input to omission and deliberately fold a typed
  Left into their existing SDK/CLI/URL/workflow boundary rejection convention.
- `resolveRtcCaptureConfiguration(input: ResolveRtcCaptureConfigurationInput):
RtcSignalingDiagnostics.CaptureConfiguration`; input has optional canonical
  `run`, `step`, `recipe`, `host` and required `sinkAvailable: boolean`. Resolve in
  that order; otherwise product-default is signaling with a sink and off without.
- `createBrowserRtcCapture(input: CreateBrowserRtcCaptureInput): BrowserRtcCapture`;
  input has complete `configuration`, `connectionId: RtcSignalingDiagnostics.Readout<string>`,
  `record: RtcSignalingDiagnostics['record'] | undefined`, and `nowEpochMs: () => number`.
  Output has required `diagnostics: RtcSignalingDiagnostics | undefined` and
  `receipt: RtcSignalingDiagnostics.CaptureReceipt`. Off installs no capability;
  Signaling requires the supplied sink; Native is unsupported in this slice.
- `initialiseRtcConnectionService(input: InitialiseRtcConnectionServiceInput):
Promise<BrowserRtcConnectionInitialization>` returns one named result with required
  readonly `webRtcConnectionService: WebRtcConnectionService` and
  `rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt`. Construct the factory
  result once in this canonical initializer and update its verified internal callers.
  No optional completed-capability input, dual construction path or old-return adapter.
- `BrowserConnectedMiddleware.rtcCaptureReceipt` is required actual initializer
  output. Transport context owns the receipt; do not add a required receipt member
  to unrelated `ApiMiddleware` aggregates. `RallarConnectionOperations.rtcCapture():
RtcSignalingDiagnostics.CaptureReceipt | undefined` returns only current actual
  construction evidence. Opaque connection identity is allocated once at connection
  composition; failed identity reads remain explicit and do not replace business errors.
- SDK defaults use `rtc.captureMode`; per-connect operations use `rtcCaptureMode`.
  Keep source origin through resolution: SDK default is host, explicit operation step.
  Other diagnostic/fault ports remain independent.
- `RallarRtcCaptureConnectionRequiredError` retains `code: 'new-connection-required'`,
  required requested/current `CaptureConfiguration` and `currentReceipt:
RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>`.
  Reject different modes before active/pending reuse without auth invalidation or
  auto-disconnect. Before receipt construction pending currentReceipt is unavailable/absent.
  Same mode with a different origin is compatible and returns the original receipt.
- `checkRtcCaptureCompatibility(input: CheckRtcCaptureCompatibilityInput):
Either<RallarRtcCaptureConnectionRequiredError, RtcSignalingDiagnostics.CaptureConfiguration>`
  lives beside the typed error and is reused by lifecycle/transport. Input has
  required readonly `requested`, `current: CaptureConfiguration | undefined`, and
  `currentReceipt: CaptureReceipt | undefined`. No current configuration or same
  mode succeeds with requested configuration; different mode returns typed Left.
  Deliberately map Left to rejection at the existing `Promise<ApiMiddleware>`
  boundary before the initialization/auth-invalid catch chain. No expected policy
  exception is thrown inside the pure classifier.

**Additional review focus:**

- A runtime JavaScript caller supplies invalid or boolean mode: reject at normalization.
- Explicit Off overrides a signaling sink and all lower-priority settings.
- A changed default during pending initialization cannot replace the first request's scope.
- Same-mode reuse retains original construction origin; desired origin is not applied proof.
- Missing sink or native implementation preserves normal connection outcomes with unavailable evidence.

- [x] **Step 1 — Write the first semantic RED at the existing owner.** Extend
      `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts` with
      explicit Off plus a real diagnostic sink at `initialiseRtcConnectionService`.
      Supply a complete `rtcCaptureConfiguration: { mode: 'off', origin: 'step' }`
      on the input variable; use the existing real inbound signaling fixture. Assert
      the original policy-retry/native business result remains, but RTC signaling
      events are empty. Current composition ignores Off and emits the observation.
      Use literal expected results; do not import not-yet-created helpers or add stubs.
- [x] **Step 2 — Witness assertion RED.** Run
      `npx vitest run packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`.
      Record the emitted-event mismatch, separately from any test setup error.
      The first witnessed failure must be the current wrong capture behavior.
- [x] **Step 3 — Add direct tests and implement the canonical contract/factory.**
      Before creating the helper owners, write their tests with literal results for
      all five precedence levels, explicit Off, every valid mode, invalid supplied
      typed Left and omitted Right `{ mode: undefined }`. Capture the actual
      composition's Signaling events, Off absence and Native unsupported receipt;
      assert other ports remain usable. Direct helper import/setup failure is not
      labeled a semantic RED; the existing-owner failure above witnesses the feature.
      Implement complete readonly types, pure resolution and the browser factory
      beneath that behavior. Use `Either.ofLeft/ofRight` for expected validation;
      install only the applied original Signaling sink/clock capability. Native is
      unsupported in this slice, with no scope/stub/implementation flag. Run the
      core configuration, browser capture and existing initializer test files to GREEN.
- [x] **Step 4 — Write and witness SDK/transport REDs.** Drive real defaults/operation
      projections and controlled native initialization. Assert default Off versus
      sink-default Signaling, step Off over host Native, direct start/connect propagation,
      and actual serialized receipts. Hold one initialization, request another mode,
      assert new-connection-required/current unavailable receipt and one original graph;
      complete it, assert original receipt. Repeat for active reuse, compatible origin
      change, explicit disconnect/connect and cancellation without stale readback.
      Run the six named test files above and retain the failing assertions.
- [x] **Step 5 — Apply selected configuration at the current construction owners.**
      Extend explicit allowlists/default clones, carry required complete
      `rtcCaptureConfiguration` into RTC initialization, build the receipt alongside
      the service, hold immutable configuration in both lifecycle/transport boundaries, and
      expose readback/error through the public connection surface. Preserve successful
      `Promise<ApiMiddleware>` and all existing admission/timer/native outcomes.
- [x] **Step 6 — GREEN and closure.** Run the six covering files, then
      `npm run test:shared-web`, `npx tsc -p packages/shared/tsconfig.json --noEmit`,
      `npm --workspace @ar-eye-hunter/shared-web run typecheck` and
      `npm run typecheck:tests`. Include shared-web API snapshot/bundle-boundary tests
      because the error/readback public surface changes. Run delivery status before
      broader checks; review/remediate each touched human-authored/support file in full,
      preserving untouched scope. Run applicable format/style/structure/coupling checks.
- [x] **Step 7 — Commit and independent task review.** Commit only this capability's
      reviewed files on the feature branch. Report exact RED/GREEN, package validation,
      full-file closure and native-unavailable staging limitation. Resolve specification
      and quality findings before Task 53. Root owns publication.

**Delivered SDK/core evidence:** Product commit `7d8bd4d035b316b9430c3dd3e28b91a08b4abd38`
and single-flight fix `de006d74b1f82978b62d269685efa3a50c442069` deliver this staged
capability. The canonical initializer returns one named service/receipt result;
transport readback reports that construction, not newly edited defaults. Same-mode
reuse preserves the original receipt/origin; different modes reject without automatic
reconnect or authentication invalidation. Startup/refresh allowlists and verified
internal consumers carry the selection; no old-return adapter or second factory remains.

**TDD and review:** The first genuine initializer RED observed signaling rows despite
explicit Off while native business behavior continued. Separate SDK/receipt and
compatibility REDs preceded implementation. Independent initial review required a
compatible synchronous reentry correction at both owners. Its REDs observed two
transport constructions and different lifecycle middleware results. One focused
ES2023 reservation capability now owns pending Promise construction; each shell
reserves before synchronous effects, drives once and conditionally clears its own
reservation. The fix preserves original synchronous throws and compatible waiters'
original rejection values, including a newer reservation surviving an older setup
failure. Final scoped re-review marks I1 addressed at both owners, with specification
and quality Approved and no new Critical/Important breakage.

**Task52 local validation:** Final focused connection/session checks pass two files/
25 tests; final `npm run test:shared-web` passes 169 files/1,395 tests including public
API, entrypoint and bundle checks. Shared/shared-web types pass; maintained test
typecheck enforces 1,454 files with zero debt/errors. Changed style, formatting,
structure and exact committed coupling checks pass. Every touched/support file entered
recursive standards closure; independent untouched code remained outside. Legacy
heuristics were individually reviewed as current policy/lifecycle boundaries, with
no retained production legacy. The scope fix did not repeat unaffected game builds;
their prior PASS retains existing large-chunk warnings. Existing measurement output
also remains disclosed as noise, not pristine validation.

**Bundle tradeoff and limits:** Only the `browser/rallar.ts` budget changes from 239
to 240 KiB under the existing `floor(measurement)+1` policy. The reported 239.163 KiB
is Brotli size of the minified browser bundle; 240 is the smallest integer cap under
that policy. Other entry budgets and native/source/control/output limits are unchanged.
Independent review accepts the intentional facade/export and boundary dispositions.
**Task52 hosted failure:** Branch Release run 37347979948/attempt 1 explicitly checked
out published commit `69c76a7dd6f62c8901d7bb9b5dab0a1a0d320253`. Its unit gate failed
only `rallar-black-box-headless/headless-bundle-boundary.test.ts`: the headless entry
measured 305.158 Brotli KiB against its 305 KiB budget. The remaining unit results were
1,372 files/12,957 tests passed and four files/12 tests skipped. Other browser, static,
database and API gates passed; RTC observation integrity and validation-evidence
publication skipped. These passes do not override the unit failure.

The headless test's existing adjustable `floor(measurement)+1` policy would require
306 KiB for this checkpoint, with explicit PR disclosure. Task53 must measure the
completed native source and close this affected consumer's actual budget and boundary
checks; its final measurement may differ. Hosted correctness remains unaccepted.
Local source support does not prove deployed availability, comparable timing, native
capture or any E3 cohort. Native remains unavailable/unsupported in Task52. Required
recipe/UI/agent/Actions/B06 propagation follows reviewed native capture. Task45/46
findings remain intact, initial native trigger UNKNOWN, E3 zero, B07 held; no Issues
created/reused.

### Task 53: Original-owner native evidence, bounded artifact and current-stats fence

**Deliverable:** Full native constructs the completed optional observation scope and
captures original PC/channel/service evidence through the existing failure artifact.
Existing current stats cannot join a retired service, peer, PC or runtime replacement.
No new performance producer is dispatched by this task.

**Files:**

- Create `packages/shared/webrtc/rtc-native-observation-scope.ts` for shared finite
  identity/admission ownership; extend canonical diagnostic variants in
  `rtc-signaling-diagnostics.ts`. Pure finite translation stays beside its native
  consumers; no old implementation is relocated or parallel recorder introduced.
- Modify `packages/shared/webrtc/qrtc-peer-connection.ts`, `qrtc-data-channel.ts`,
  `flush-rtc-ice-candidate-queue.ts` and `packages/shared/services/web-rtc-connection-service.ts`:
  original native capture, candidate invocation evidence and service issuer evidence.
- Modify Task 52's browser capture factory, RTC/middleware initialization and transport
  shutdown for native construction and diagnostic-only disposal.
- Modify `packages/shared-web/browser/rtc-diagnostics/browser-rtc-diagnostics-runtime.ts`
  and `rallar-rtc-facade.ts`: captured current-stats identity and post-await exact-object fence.
- Modify the existing diagnostic translation/projection in
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts`
  and `tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts`.
- Test `packages/tests/shared/webrtc/rtc-native-observation-scope.test.ts`,
  `packages/tests/shared/webrtc/rtc-native-observation.test.ts`,
  `packages/tests/shared/qrtc-peer-connection.test.ts`, `qrtc-data-channel.test.ts`,
  `flush-rtc-ice-candidate-queue.test.ts`, `webrtc-connection-service.test.ts`,
  `webrtc-retained-peer-redial.test.ts`, Task 52's browser capture/initialization tests,
  `packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts`
  and `packages/tests/rallar-black-box/live-rtc-agent-diagnostics.test.ts`.

**Interfaces and exact constraints:**

- Consume Task 52's canonical configuration/receipt and factory. Native construction
  creates `RtcNativeObservationScope.create({ createScopeId })` before service/native
  graph effects; one optional nonce source call, followed by local monotonic allocation.
  Return its canonical `RtcNativeObservationScope.Capability`; no alias, per-lifetime
  external callback, ID registry or business rollback. Service exposes
  `disposeNativeObservations(): void` for owned diagnostic-only shutdown.
- The specification defines all required new `RtcSignalingDiagnostics` readout/state/error/
  snapshot/candidate/service/status/limit/unavailable variants. Preserve observed versus
  none-observed actual-window versus unavailable after real JSON serialization.
- Fixed per-scope caps: 256 setups, 256 PCs, 1,024 channels; each setup reserves timeout
  and termination, each PC/channel its own final snapshot. 4,096 ordinary + 1,792
  terminal + two status + one notice = 5,891 maximum new attempts. Source data 8,192
  UTF-8 bytes; overflow uses a same-slot unavailable row without recursive fallback.
  Retention100 surviving A/B scopes retain counters across cycles. Keep existing
  16,384-byte rows, 600-row pool and 262,144-byte output; no completeness guarantee.
- Candidate drain accepts optional `onCandidateObservation` under canonical
  `FlushRtcIceCandidateQueueObservation`, with submitted/returned/rejected and actual
  spliced index. Parent PC supplies exact identity and operation ordinal; target
  transport and ICE-generation associations remain unknown. Fragment equality work
  accepts only nonempty strings up to 256 code units and exports no raw fragments.
- Optional `readCandidateError(caught)` supplies canonical finite facts through an
  exact-owner synchronous error-read marker. Restore its prior marker in `finally`;
  reader failure yields unavailable/read-failed without rereading the native value.
  The sanitized rejected DTO and original FIFO/count/continuation remain unchanged;
  no diagnostic read runs without an observer and no marker spans a native await.
- Browser entry/headless bundle budgets retain their existing adjustable
  `floor(measurement)+1` policy with explicit PR disclosure. Measure the complete
  native source and change only an actually exceeded cap to its minimum integer;
  the Task52 browser cap is its checkpoint, not a permanent Native-feature ceiling.
  Recheck the whole boundary suite: the size loop can stop at its first failed entry.
  This policy does not waive file-length standards or raise native/source/control/
  output limits, and the failed checkpoint remains part of the evidence.
- Native/service captures are frozen before external effects, quota consumed before
  sink, publication after existing business callback sequences. A detached channel's
  error window ends; later events cannot fill its typed summary or mutate replacement.
- Publication batching is owned by each captured operation/lifetime. Match its exact
  native binding/object, never its exported identity readout. Restore synchronous
  context before an existing await and pass exact batches through owned
  continuations. Pending obsolete work cannot hold reset/retirement/replacement rows.
  Service nesting retains exact peer/batch handles only until its synchronous effects
  finish; late completion cannot drain a replacement. Arbitrary app work after its
  own await uses its own owner boundary; no implicit async context or new await.
- Getter-triggered synchronous retirement uses the exact binding's in-progress
  marker. The nested complete snapshot reports unavailable/read-failed native-state
  reads and preserves sealed finite errors with truthful coverage; incomplete error
  reads are unavailable, never none-observed. Business teardown continues, the retired
  outer capture is discarded, and cleanup cannot suppress a replacement binding.
- Parent native reads from a channel snapshot use a narrow synchronous peer-owned
  operation. Each owner restores its own exact marker; the channel never writes its
  parent's marker. Service capture freezes original entry/setup/PC and at most four
  compact-channel handles/count before getter effects, captures the original peer
  first, then matches both original PC and native DC. Keep truthful missing/truncated
  compacts; no replacement join, unbounded handle copy or live iteration after reads.
- `RallarRtcPeerDiagnostics` gains required captureIdentity/statsObservation. The
  existing single getStats read fences original service/peer/PC/runtime after await;
  retired-during-read omits candidate pair and reports statsAvailable/usesRelay false.
- Lifecycle-history gains the specification's mandatory bounded-partial/unavailable
  nativeObservation summary in the same existing output budget and recorder path.

- [x] **Step 1 — Witness ownership/budget REDs.** Use real scope/native/service
      owners with controlled native edges. Assert first generic/typed summaries survive
      original teardown and ordinary exhaustion, original timeout/deletion issuer survives
      callback replacement, detached channel cannot gain a later typed error, one nonce
      call completes before graph setup, and diagnostic denial does not deny native work.
      Run the named native/scope/service files; record independent failure assertions.
- [x] **Step 2 — Implement native/service capture and safe publication.** Keep state
      only at explicit lifecycle owners and pure finite translation at boundaries. Preserve
      original exceptions, callbacks, FIFO/counts and continuation. Add disposal at each
      existing initializer handoff/failure and shutdown after disconnect-peer captures.
- [x] **Step 3 — Witness serialized artifact/privacy REDs, then implement projection.**
      Translate through actual browser/control JSONL and existing lifecycle-history reader.
      Assert maximum-shape native variants fit source/control bounds; missing/null/invalid
      nested error coverage is malformed, never none-observed. Inject forbidden raw SDP,
      fragment/address/credential/error text at each nested boundary. Exhaust the shared
      suffix/output budget and assert explicit partial/unavailable/malformed/limit flags.
      Run `npx vitest run packages/tests/rallar-black-box/live-rtc-agent-diagnostics.test.ts`.
- [x] **Step 4 — Witness delayed-stats RED, then fence exact objects.** Delay one real
      reader call; replace native PC, entire peer, service and middleware/runtime in separate
      cases, including late rejection. Assert captured pre-await identity, retired-during-read,
      no replacement pair and one existing read only. Run the named stats test file.
- [x] **Step 5 — GREEN, public consumers and closure.** Run covering tests, then
      affected shared/shared-web/shared-test tests/typechecks and live diagnostic consumer
      compilation. Exercise all fixed admission caps, 204 setup/PC + 816 channel stress
      allowance and 5,891 ceiling without resetting a persistent scope. Include native
      API absence/throwing getters, listener attachment/replacement, sink/app reentry,
      initializer cancellation and original native constructor exception. Add actual-owner
      getter-triggered reset/removal: preserve business teardown, serialize complete
      unavailable/read-failed snapshot fields, suppress the retired outer mixture and
      prove independent replacement capture. Public snapshots, browser bundle-boundary
      checks and affected game app builds follow focused checks.
      Every changed/support file enters full recursive standards closure.
- [x] **Step 6 — Independent review and publish the coherent capability.** Complete
      specification/quality review before choosing the next horizon. Do not label source
      support as deployed availability, complete first-stall capture or acceptable overhead.
      Next required outcomes remain recipe/UI/agent/Actions/B06 configuration propagation;
      a later unchanged diagnostic/perturbation exercise needs its separate selection.

**Current Task53 status:** All six source steps are completed at the published
checkpoint described below, including explicit human acceptance of the two historical
TDD sequence deviations. Marking these steps complete does not erase those deviations
or certify present native availability, performance overhead or B01–B06/E3 acceptance.
Current end-to-end acceptance remains tracked in Tasks60–65 and the completion gate.

**Task53 corrected source checkpoint (2026-10-05):** The initial independent review
reproduced publication blocked by a retired operation, invalid retained-error coverage
and lost admission/transport reasons. The original implementer's scoped corrections
now have witnessed semantic RED/GREEN evidence, including unavailable-identity batch
membership and independent late completion. The uncommitted native/service artifact
support has passing focused semantics and complete public API/entry/bundle checks.
The first whole-project run on frozen tree0455e37 failed one package-boundary test:
14,513 tests passed and 12 skipped, but a changed diagnostic test imported the private
benchmark JSON type. The existing boundary rule was preserved; the fixture now uses
the canonical shared API JSON contract. Witnessed focused RED then GREEN covers both
the unchanged package boundary and the diagnostic consumer (67 tests), and maintained
test types pass. The final whole-project run on corrected freezec4f3de4 passed:
1,486 files/14,514 tests, four files/12 tests skipped and 16 Node experimental
localStorage warnings. All 36 frozen file hashes remained unchanged. Scoped
independent re-review addressed the original I1–I4 findings, including the approved
length-only registry entries. It found one new queued-invocation ordering regression:
a synchronous native event can publish to a reentrant diagnostic sink before queued
candidate success accounting. The direct path records success first. The retained
production-owner probe confirms the distinction; the original implementer is fixing
each queued native-call boundary with witnessed TDD. This is a new instrumentation
defect, not evidence of the historical post-ICE trigger. The original failed logs and
the passing whole-project checkpoint remain retained; acceptance awaits the scoped
correction and re-review.

The round1 peer/service owners measured 1,617/1,360 effective lines against the
1,200-line backstop, with cognitive loads 267/142 and no named function above 60.
The human's 2026-10-05 length-only approval is recorded in the
[focused exception registry](../../repo-code-style-exceptions.md), with original
ownership rationale and review/removal conditions. The raw changed-style result
remains FAIL45; registration does not suppress its findings. Final measured browser
245.8173828125 KiB fits cap246; headless314.28125 KiB requires minimum cap315.
Earlier failed boundary/hosted checkpoints remain preserved. Two historical TDD
sequence deviations remain disclosed and unresolved; later tests do not rewrite
that history. Task53 remains uncommitted and unaccepted. These diagnostics corrections
do not establish the historical post-ICE cause or any performance acceptance.

**Task53 scoped round2 source checkpoint:** Four actual-owner ordering REDs preceded
the minimal correction at each queued native call. The existing method-only queue
capability now enters the peer's synchronous capture boundary, preserving the exact
native receiver/promise and restoring context before await. No queue API field, loop,
retry or observation owner was added. All 28 candidate tests pass, including sink/clock
at the first, rejecting and later invocation, plus held-promise cases with observed
and unavailable identities. Covering30files459tests and public API/entry/bundle33tests
pass; shared and maintained1,457-file test types pass.

Round2 product treeae02bf4 has only two changed files. The peer now measures1,620
effective lines, cognitive267/maxnamed49; service remains1,360/cognitive142. The
approved length-only registry has the current peer count and unchanged scope. Raw
changed-style remains FAIL46; its additional unknown is the test's captured console
warning value, retained only to assert the original Error identity. No new hard
function/cognitive or legacy exception is granted. Fresh browser245.9150390625 and
headless314.1650390625 Brotli KiB fit unchanged246/315caps. Earlier failures and
source-specific measurements remain retained. The full project run on coherent
freeze23ed94b passed1,486files/14,522tests, with four files/12tests skipped and16Node
experimental localStorage warnings. All36 frozen source/doc hashes remained unchanged.
The original independent reviewer marked N1 ADDRESSED, found no new breakage and
approved the scoped correction's specification and quality. At that review, historical
I5 remained unwaived: the initializer-failure cleanup edit preceded retrieval of its completed
RED output, and the initial PC read guard preceded its dedicated reentry test.
The current fixes are tested and reviewed; this does not rewrite their original
sequence.

**Human process acceptance (2026-10-05):** After those two deviations were explained,
the maintainer instructed: "Keep it. Ensure TDD and follow skills guidelines and goal."
This explicitly accepts retaining the current tested and independently reviewed fixes
with the historical deviations documented. It grants no future TDD waiver. Task53's
source acceptance gate is satisfied and its native source is published in draft PR #633.
The existing length-only
registry approval remains separate. End-to-end recipe/UI/agent/Actions configuration,
fresh hosted correctness and original baseline acceptance remain required. No deployment,
baseline or post-ICE cause claim follows.

**Automated delivery reconciliation:** The raw `npm run check:repo-style:changed --
origin/main` on the published native source exited 1 with the same 46 native findings.
The existing reviewed-disposition policy already provides exact path/rule/checker-owner
matching and numeric bounds. The test-first correction records 44 distinct keys:
33 finite-boundary owners and 11 numeric ownership bounds, including the two separately
approved lengths. Two existing cognitive bounds are updated in place. Its focused run
fails with 21 expected assertions before policy edits, then passes all 34 tests. Covering
checks pass 185 tests; maintained test types enforce 1,457 files with zero errors/debt.
The final active changed-style gate passes against merge base
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1`. The frozen new-source full project suite passes
1,486 files/14,542 tests, with four files/12 tests skipped and 16 disclosed Node
experimental-localStorage warnings. Full scanner findings remain visible; unrelated paths, rules,
named owners, prefixes and over-bound magnitudes remain unreviewed. An absent checker
symbol is an exact module-level owner, not automatic per-method protection; every
touched owner still requires manual review. This correction changes no native runtime,
global threshold, base tolerance, parser or source discovery.

**Normal hosted checkpoint:** [Branch Release 37377565689](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37377565689),
[formation 37377565279](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37377565279)
and [medium 37377565300](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37377565300)
pass for published `884db0496cc6a4109a7fc90e225705da8551fce3`. Release actually tests that
commit; formation/medium test PR merge `dabde99ab85fd8a35eed75aad9b198901dec524f`, whose
tree is the identical `7d8a6bb31ded12944e85e00e8045e3fda1bc0c9c`. Independent artifact
audit accepts all 101 recipe reports with zero blocking failures and 196 explicitly
nonblocking intermediate convergence failures. Declared report truncation limits per-step
reconstruction; the RTC observation integrity job is skipped in broad mode. This accepts
normal correctness of the native/style checkpoint, with no new supported-manifest,
target-native availability, first-stall, observer-cost, B06 or cohort acceptance. It does
not certify the uncommitted Task54 source.

### Task 54: Executable recipe capture selection and truthful SDK provenance

**Code facts and design:** Before this slice, the actual SDK connect owner supplied only step,
host and sink inputs to the canonical resolver. A recipe-selected scalar passed as
the existing `rtcCaptureMode` would acquire step origin. The accepted implementation
shape is a narrow product-owned sparse `rtcCaptureContext` carrying canonical run and
recipe selections alongside that existing step option. The SDK retains the sole
precedence decision and original construction/readback path. This is an intentional
public input addition; product packages never import shared-test, and adapters never
rewrite a receipt origin or supply a pre-resolved configuration.

Shared-test owns authored `recipe.rtcCaptureMode`, the run command's override, and the
step selection under the existing connection configuration. Typed contracts, schemas,
wire parsing and direct executable validation must agree. Off remains explicit;
Inherit remains omission at the operator boundary. Invalid supplied modes fail before
connection effects. Capture-specific Configure state belongs to its execution sequence;
immutable run authority survives Configure, and parallel/nested siblings cannot leak
desired step state. Accepted executable commands and capture inputs are snapshotted at
their typed owner, preserving opaque payload semantics. No body hash or complete remote
body identity is claimed before that boundary is validated.

The original adapter operation key could return a cached pending promise before SDK
compatibility ran. Two CRDT connected shortcuts could also bypass connect. Capture inputs
must reach canonical compatibility/readback through those paths. Existing adapter
serialization differs from direct SDK pending rejection and must remain explicit. A
compatible reuse returns its original actual receipt, even when the new request's origin
differs. An incompatible request reports the typed failure and current evidence, without
automatic reconnect or authentication invalidation. WS fallback and live CRDT use the same
invocation selections; local-only CRDT reports no applicable connection override.

Actual integration also exposes two missing paths: the SPA bridge omits the page runtime's
existing CRDT methods, and automatic CRDT catch-up calls an SDK no-intent message acquisition
wired to explicit connect. The latter re-resolves defaults and rejects the Native connection
it just constructed. Direct method forwarding belongs at the existing SPA boundary. Internal
connection acquisition belongs to the original auth/session owners and preserves their actual
active or pending capture and one reserved constructor path. It retains auth-end, missing or
replaced-session reconciliation, expiry, cancellation and original errors; an outer cached
middleware shortcut would bypass those checks. Explicit connect still resolves requested intent
and rejects incompatibility. The affected messaging/media/realtime composition callbacks enter
full touched-file closure, with active and held-pending acquisition and auth preservation tests.

The affected validation initially passes 525 tests and fails the browser facade's strict
Brotli ceiling: 246.068359375 KiB against 246 KiB. The required recipe/context/acquisition
behavior adds 157 compressed bytes over the published native checkpoint. The existing
bundle test explicitly permits the minimum strict whole-KiB ceiling, so only that canonical
ceiling changes to 247 KiB, with the original failure retained and the cost disclosed in
the PR. Other ceilings and native capture source budgets stay fixed. This packaging
adjustment establishes no performance improvement or accepted observation.

The first frozen full suite passes 1,489 files/14,582 tests and fails three tests,
with four files/12 tests skipped. Two exact consumer delegation assertions lack the
intentional sparse capture context; their strict expectations are corrected. The headless
bundle measures 315.3818359375 Brotli KiB against 315 KiB, adding 1,246 bytes over the
published native checkpoint. Its existing minimum whole-KiB policy changes only the
headless ceiling to 316 KiB; forbidden UI/runtime dependency checks stay enforced.
The original frozen source and failures are retained. The first active changed-style gate
also reports 16 findings. The support correction adds nine exact reviewed owner keys,
including one cognitive cap of 50, after semantic RED and full completed-output reads;
all 42 policy tests pass. Checker thresholds, parser and tolerances stay fixed, and
absent symbols remain coarse owner identities requiring manual review when touched.

**Corrected local evidence:** The frozen 47-file source passes 1,492 files/14,593 tests,
with four files/12 tests skipped and 17 Node experimental-localStorage warnings. All
47 before/after hashes agree. Separate shared-test/shared-web compilers, maintained
test types (1,463 files, zero debt/errors), public API and bundle checks and all four
affected app builds pass. The active changed-style gate passes against
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1`; full-scanner warnings remain visible.
The commit-based legacy scan reports the same 22 concretely resolved naming/boundary
candidates. This is local validation awaiting independent specification/quality review,
with no source acceptance, distributed/B06 application or performance acceptance implied.

The first independent review withholds specification and quality acceptance for two
confirmed defects. A reference-only run selects its loaded body after publishing running
state, so a synchronous subscriber can replace the body and attribution of an already
admitted run. Direct loop/parallel admission also validates later capture fields only
when each child is reached, allowing earlier connection effects before rejection. Fix
round 1 captures the accepted loaded body before reentry and applies one finite recursive
capture validator before composite effects. Four admission/reentrancy assertions fail before
the body correction and then all eight acceptance tests pass. Eight direct composite assertions
fail with an earlier connection effect before the validation correction. Covering tests pass
80 tests across nine files; shared-test and maintained test compilers and the current changed-style
gate pass. Final frozen validation passes 1,492 files/14,607 tests, with four files/12 tests skipped
and 17 disclosed Node warnings. All 47 before/after hashes agree. The original reviewer
marks both Important findings addressed and approves specification and quality for the
correction, with zero new findings. Together with the original review, this approves Task54's
behavior at that frozen source. The subsequent actual hosted delivery failure below reopens
support/test closure without invalidating those source-specific behavioral results.

An additional loop Map identity assertion exposes existing downstream placeholder templating,
which deliberately traverses authored payloads. That assertion is excluded from proof of the
capture validation defect. The loop preservation assertion uses ordinary authored data containing
capture lookalikes; strict Map identity remains tested at snapshot/parallel admission. Capture
validation stays finite and does not walk payloads. The independent loop templating owner is
outside this correction. All original failures remain retained.

The earlier passing local suite remains source-specific evidence. Disclosed validation warnings
are a deferred Minor for final review; they do not authorize suppression or runtime tuning.

**Published6d hosted checkpoint:** [Branch Release37386478315](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37386478315)
fails on six unclassified test-coupling occurrences at actual checkout
`6d7438f3c54397ba7e8cf14428260369f6a2405b`. The changed-style and navigation gates pass;
reachability, workspace typecheck, deployable app builds, Deno app checks and validation
publication are skipped after the coupling failure and are not accepted at this source.
[Formation37386476237](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37386476237)
and [Medium37386477282](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37386477282)
succeed on merge `7579f0bf94eda7b88ad4b7a0a00d41c0c2e028ed`, independently verified to have
the identical `c7e6de332cbc78898e7631b5a5847a4ca89bcea2` tree. Executed unit suites pass
14,607 tests with 12 skipped; dedicated PostgreSQL coverage passes 85 tests. All101 recipe
reports have zero blocking failures and386 declared nonblocking convergence attempts.
Declared report truncation limits per-step reconstruction. RTC integrity remains skipped
in broad mode. This earns no native availability, B06, performance or distributed acceptance.

Fix2 changes test fixtures and exact interaction classifications, with no selected runtime
change. Four counts protect compatible cache reuse, one replacement connection construction
or the existing WS fallback retry. Incidental production source reads in the touched policy
suite become controlled scanner fixtures with the same positive and negative policy behavior.
The completed failed gate is the delivery acceptance RED. This preservation work is not
relabeled as new semantic TDD; any new checker or runtime behavior would require its own
witnessed behavioral RED before implementation. Final focused validation passes99 tests
across four files; maintained types enforce1,463 files with zero debt/errors. The real
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1` to isolated fix candidate
`2590eb02016096a0650be7f545e01826c75189b6` changed-range gate passes all11 current
classifications and full registry validation. All276 prior contracts/423 entries are
preserved exactly, with four narrow additions each. All three frozen hashes agree.
The original reviewer approves specification and quality for the correction, resolving
all six findings with zero new findings. No broad production suite or app build is repeated
for these test/registry-only edits. These local results do not claim fresh hosted acceptance.

**Observable acceptance:**

- [x] A real JSON recipe/run decode, invocation, browser decoder and SDK construction
      returns the literal winning mode/origin and actual receipt, including explicit Off
      and all precedence levels. A fake echoed configuration does not prove application.
- [x] Invalid run/recipe/Configure/step input fails at wire and direct-runtime boundaries.
      Caller mutation after acceptance cannot change the captured executable selection.
- [x] Interleaved ordinary, nested, loop and parallel executions retain their own run
      authority and Configure state. Replayed top-level results retain original attribution;
      repeated child template IDs still represent real executions.
- [x] Actual SDK and black-box adapter active/pending reuse, explicit disconnect/connect,
      WS fallback and both live-CRDT shortcuts preserve compatibility and actual receipts.
      Missing sink/receipt and cancellation remain truthful unavailable dispositions.
- [x] Focused behavioral tests, affected shared-test/shared-web and maintained test types,
      intentional public API/bundle checks and affected app builds pass, with full recursive
      touched-file closure and independent specification/quality review.

All five checked requirements retain their verified local/source scope. Fix2 closes the
support/test findings through actual changed-range validation and scoped review; the new
published853e normal hosted checkpoint below is accepted at its own scope.

The next outcome after this slice is targeted-agent support, distributed invocation/application
attribution and materialization/restore. UI, local/hosted bootstrap, Actions/helpers and sealed
B06 mode/cohort validation remain required later outcomes. No new RTC producer, retry policy,
accepted E3 cohort, performance result or historical post-ICE cause is selected by this work.

**Corrected853e hosted checkpoint:** [Release37389173416](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37389173416),
[Formation37389172709](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37389172709)
and [Medium37389172399](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37389172399)
all succeed. Release actually tests `853e072c7843f58cfda3e5304f34eb6d329c8a68`; formation/medium
check out merge `4413fcec1d157ef518364d3132b984d8ccc18000`, independently verified to have
identical tree `9ff7c7bf8827f24f0c976293104bb05fcce203f4`. The corrected coupling gate and
formerly skipped reachability/types/build/Deno checks execute successfully. Fresh v2
publication matches this PR/run/attempt/head and the independently reconstructed build digest.
All101 current recipe reports pass with zero blocking failures and230 declared nonblocking
convergence attempts. Hosted units pass14,607 tests/12 skipped; the PostgreSQL lane executes
the skipped SQL cases. Truncation and broad-mode RTC-integrity skip remain explicit.
This accepts normal correctness only: native availability, first-stall capture, observer
cost, B06/E1/E3 and distributed acceptance remain outstanding. Prior884/6d evidence is unchanged.

### Task 55: Completed distributed source preparation

These are source findings at the accepted9d checkpoint, not claims that the later local
Task61/62 implementation is absent. Task61 now supplies locally accepted executable intent;
Task62's installed support change is completing validation and awaits independent acceptance.
At the audited checkpoint, manifest/selection schemas and builder have no finite run override.
The start-command owner must project that override into ordinary recipe execution; it must
not introduce a second precedence resolver or redundant selection knob. Omission means
Inherit, while Off is explicit.

At that checkpoint, agent capability advertisement lacks capture support/version. The ordinary resolver checks
only existing assertion capabilities, and explicit targeting bypasses those blockers.
Every actual target must satisfy required capture support before relevant work, including
manual starts without staging. Preserve unrelated Health/API/local-only behavior and the
existing explicit-target baseline when no capture requirement applies.

The refreshed read-only audit of exact9d/tree061 confirms that owned Connect completion
already returns the actual SDK receipt and original middleware eligibility. The first normal
loss is control evidence compaction: it discards nested ordinary successful results while
retaining invocation metadata and bounded failure summaries. Distributed result acceptance
checks only outer `ok`; the wire decoder does not validate application or its attribution.
Do not replace this owned completion with later global receipt readback.

Export paths differ. The configured disk `results.jsonl` may retain the original sanitized
envelope, but accepted snapshots, restored runs, fallback JSONL and distributed bundles
inherit the compacted loss. Retaining the raw side channel does not close typed admission
or establish that the distributed success verdict checked the receipt. Reuse that recorder.
Retain finite typed attribution through the existing control and distributed owners:
run, agent, phase, accepted body, invocation, command, connection and actual receipt.
Missing, malformed, mismatched or unavailable required application cannot pass. Explicit Off
retains its minimal receipt; compatible reuse retains its original construction origin.
Cancellation and failures remain truthful. No generic payload walker, recorder duplication
or budget increase is selected.

Reference-only staging currently reports a loaded recipe ID and starts an ambient body.
Task54's acceptance ID is not a content hash. A later coherent slice must guard the actual
staged body/configuration before effects, preserve that attribution through snapshot restore,
replay and artifact export, and distinguish replayed completion from fresh application.
The existing materializer already owns effective body hashes and spawn isolation; runner
selection must use that owner, preserve authored bodies and GroupRef scope, and avoid a new
process lifecycle for no-spawn recipes. UI/bootstrap/Actions and B06 attachment remain later
required outcomes. No distributed behavior is claimed from this read-only preparation.

### Task56: Fenced SDK message capture prerequisite

**Status:** Local source acceptance after independent specification/quality approval.
Fix round 1 closes stale volatile admission; no new fix findings remain. Corrected frozen
validation passes 1,493 files/14,661 tests, with four files/12 tests skipped and 16 visible
Node storage warnings. All 43 hashes agree before/after. Actual changed coupling/style,
browser budgets and four affected app builds pass. Delivery continues through draft PR
#633. Both subsequently diagnosed observer fixture races have test-first readiness
corrections and scoped independent approval. Required normal hosted correctness is
accepted for published `a74be0ee561494085f2c18dce38264e404ee792b`; end-to-end diagnostics
and baseline acceptance remain open.

Focused implementation and recursive self-review complete; changed-range
gates, types, browser boundaries and four affected app builds pass. The first frozen
full suite fails two tests: the headless bundle exceeds its strict316KiB shipping budget
at316.262KiB, and the native supersedence fixture reaches an unavailable auth/storage
port. Source tracing finds the fixture mock is installed after composition captures
the real auth reader. Module-time mock binding passes all32 authority cases; the
authored packaging policy's minimum316→317KiB correction passes its boundary test.
Both support files receive full recursive review; the failed snapshot remains retained.
The repaired frozen full suite passes 1,493 files/14,647 tests, with four files/12 tests
skipped; 16 Node storage warnings remain visible. All 43 before/after hashes agree,
and repaired changed-range style/coupling gates pass. Independent specification/quality
review requests changes for one Important finding: storage-to-volatile admission
awaits, then queues through the original context without repeating the current-auth
fence. A bounded canonical-message diagnostic queues after authentication replacement
while ownership reports session-not-current; its malformed first fixture is excluded.
In fix round 1, two actual SDK regressions fail across the missing-storage shortcut
and asynchronous storage-unavailable result; 30 tests pass, including both unchanged-owner
controls and historical receipt assertions. Root reads the complete RED and verifies
production and policy files unchanged before releasing minimum GREEN to the same
implementer. A corrected lifecycle RED then fails four cases and passes 32 before
production changes: stale auth admission and its missing failure evidence, plus late
admission onto disposed/replaced graphs. An earlier incorrect handle-observability
assumption and its timeouts remain excluded. The minimum correction passes 58 tests;
expanded focused validation passes 200 tests, with package and maintained-test types
passing. Root reads the complete logs and full two-file closure report. Corrected-source
freeze, affected gates and scoped independent re-review still decide acceptance. Existing
validation noise remains a nonblocking review finding.

The initial actual-SDK queue run fails two cases
(active and pending Native) and passes five preservation cases: explicit Off sends enqueue
instead of returning the existing typed incompatible-configuration refusal. Root read the
complete157-line failure and verified only the test/plan changed before releasing minimum
GREEN. Three further semantic failures prove unavailable required capture admits a send,
authentication replacement in message creation admits on the old session, and opaque payload
serialization can mutate accepted capture intent. Their focused correction passes ten tests.
The existing page JSON-result test then fails because the actual Off receipt is absent;
its focused correction passes. Further semantic failures prove recipe run intent is dropped,
typed page refusal evidence is lost, and final clock reentry needs an explicit refusal.
Self-review then exposes an ordinary-send regression: a clock exception escapes instead of
settling the original failed handle. Its independent RED precedes the correction preserving
ordinary failure handling. Setup and unsupported-payload fixture failures remain excluded
from semantic RED evidence. Focused closure passes380 tests; later targeted corrections pass
270 message,21 page and53 acquisition/auth tests, without pooling those overlapping counts.
The public snapshot passes12 tests after exactly two intentional additive error exports.
The author reports whole-file closure of37 package files, followed by two recursively
reviewed tooling files, the complete evidence registry and the two validation-repair
support files. The actual changed-style gate rejects the public SDK entrypoint's
13th value export. Full entrypoint review confirms the new typed refusal belongs to that
same public responsibility. Controlled policy tests first fail at13, then pass its exact
reviewed disposition while still rejecting14 and unrelated findings; thresholds, parser
and growth tolerance remain unchanged. Focused tooling validation passes86 tests and
maintained test types report1,464 files with zero debt/errors. The initial immutable
candidate's coupling gate finds five unclassified assertions. Source review removes two
redundant initializer counts, restores the existing auth-replacement contract's occurrence
identity, and classifies three exact zero-admission effects. Focused acquisition/checker
validation passes64 tests; the selected-file check classifies all four remaining findings.
The first comparison preserves all280 old contracts and427 entries. Subsequent full-file
registry review finds inaccurate ID guidance, four misplaced rationales, four stale or
misdirected test references, and one unsupported enumeration approval. Narrow evidence
corrections and removal of that ungrounded approval follow current source/tests; no
checker policy or referenced implementation changes. The immutable changed-range gate
still precedes acceptance. All75 initial legacy
heuristic candidates map to current routing, translation or public-surface requirements;
no retained legacy exception is selected. Root read the complete reports and terminal logs;
current changed gates and frozen-source broad validation still decide delivery. No
production, deployed or performance acceptance is claimed.

The original reviewer then approves scoped fix-round specification and quality:
the post-storage continuation repeats the original owner/capture policy and epoch
check immediately before the volatile effect. Stale required auth settles through the
existing failed-admission lifecycle with a finite reason; closed epochs receive neither
late queue effects nor invented terminal settlement. Historical handle receipts remain
unchanged. Current required owners and omitted-intent callers retain ordinary downgrade.
The corrected immutable source passes one justified new-source full-suite run, 14,661
tests/12 skipped. The earlier failed and repaired snapshots remain separate evidence.
Root also discloses an ignored style-log filename collision: the later changed-style
PASS log is retained separately, while the complete previously read inventory is recovered
from its tool output with no original-byte hash claim. Direct source review and actual
SDK semantic evidence decide the verdict. No source or frozen hash was altered by that
evidence-path correction. Existing nonblocking warnings carry to final whole-branch review.

Fresh Branch Release `37401847307`, app-browser job `112070926065`, actually checks out
published `12eaac58ebe9494befa865015e4858a19388d039`. `npm run test:rallar` fails
`observer-presentation.spec.ts:29`: its opened report does not contain the recorded
`rallar.browser.observer.first` topic within the existing 10-second expectation. The lane
reports 45 passed/64 skipped/one failed, and its following in-memory full-stack step is
skipped. The raw failed log is retained. This is a required hosted failure, separate from
the passing local suite and closed I1. Formation and Medium-Scale pass at pull-merge
`fc39fe2a8bb78884e67764367ec620b8fb5c7389`, whose actual tree exactly matches published
`12ea`; all 101 recipe report summaries match their seven matrix totals. Five event
histories and four result reports remain truncated. Branch retains 134 nonblocking
command failures and Formation 130; aggregate recipe success does not erase them or
substitute for the failed browser lane. Branch's fresh validation publication is skipped.

The unchanged existing focused browser spec completes one FAIL/one PASS. An ignored
instrumented copy retains the final five-event assertion and fails with four events:
the first injection occurs while bootstrap is busy/resetting, then the recorder clears
it 97 ms later. Source tracing follows the startup effect through `startBootstrapOnce`,
`runSample`, `resetForRun` and the runtime reset, which awaits the existing simulated
executor before replacing recorder state. Visible report controls do not establish
bootstrap readiness. This is a fixture readiness race, with no demonstrated production
recorder or observer defect. Raw failures, complete relevant notification projections,
trace and screenshot are retained; repeated nested report statistics were parsed rather
than claimed as manually reread verbatim. Root independently verifies all 42 published
nonplan files unchanged before releasing the same implementer for the minimum test-only
readiness correction. Preserve every disclosure/navigation/filter/draft/redaction/history
assertion and all reset/retry/timeout/cap behavior. This genuine fixture RED is separate
from product semantic TDD; no product GREEN or timing acceptance follows. Independent
scoped review and fresh required hosted correctness/publication still decide closure.
The minimum correction adds only an inline causal comment and an expectation that the
existing workbench status is `passed` before recording the first event. The original
focused Chromium spec completes two PASS/zero FAIL, preserving every prior assertion;
strict browser-spec typing, formatting and target-file style pass. All 42 published
nonplan paths remain unchanged. Initial check-command usage errors are retained and
excluded from validation. This GREEN repairs test readiness without changing the product
or accepting observer timing; broader browser validation and independent review remain
pending at this checkpoint.

The first corrected freeze's full app-browser lane then completes 45 PASS/64 SKIP/one
FAIL: the report case passes, while the unchanged evidence-panel case loses
`observer.current` at line 110. Root reads the complete failed output and verifies both
frozen hashes unchanged. Original-reviewer scoped review marks the first finding
addressed but requests changes for this remaining touched-file/delivery blocker; no
breakage introduced by the two-line correction is established. Its subsequent stream
assertions are unreached in that failed run. The in-memory full-stack check stays held.

The same implementer diagnoses before any further edit. One traced sole-case execution
passes because injection follows reset by 88 ms; it is retained as a non-reproduction.
A default-trace execution reproduces the exact failure: entering the workbench starts
bootstrap reset, `current` is injected while reset is pending, and the recorder clears
it 12 ms later. Selected browser/warning filters correctly admit the event. This is a
second fixture-readiness race with no demonstrated production defect. Root reads the
complete relevant chronology/failure and independently verifies all 42 published paths
and both frozen paths unchanged before releasing the minimum existing readiness
expectation at this second injection boundary. Preserve the initial direct-mode event,
all assertions and the existing helper/reset behavior. Default-trace focused GREEN,
new scoped review, justified covering repeat and fresh required hosted delivery decide
closure. The second correction adds one inline existing status expectation before
`current` is recorded. The unchanged original pair with default tracing completes two
PASS in 20.6 seconds; strict browser typing, formatting and touched-file style pass, with
all original assertions and all 42 published paths unchanged. Default tracing produces
no new successful-run screenshot/trace/console capture, so no such evidence is claimed.
Original-reviewer scoped specification/quality re-review marks the second finding
addressed with no new fix breakage or open blocking findings. The justified frozen-source
full app-browser repeat completes 46 PASS/64 SKIP/zero FAIL, including both observer
cases; the previously skipped in-memory full-stack script then completes seven PASS.
Root reads both complete outputs and verifies the frozen files and real HEAD/index
unchanged. Current repair-range coupling and changed-style checks pass; prior unit and
product checks retain their original scopes because all 42 published source paths are
byte-identical. Node color warnings and the full-stack expected missing-ticket 401
diagnostic remain disclosed. Only final plan outcome prose differs from the reviewed
freeze before publication. Fresh exact-source hosted correctness/publication now closes
Task56 delivery at its normal correctness scope. This neither waives future product TDD
nor accepts observer timing.

**Fresh hosted acceptance:** Published `a74be0ee561494085f2c18dce38264e404ee792b` has
[Branch Release 37404814266](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37404814266),
[Formation 37404814043](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37404814043)
and [Medium 37404814096](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37404814096)
SUCCESS. The independent audit verifies actual Branch checkout a74 and formation/medium
pull-merge `3fb63ada40ed0fd46e4643eee88d2ef624d6d1d1`, all with identical tree
`44c10c2b1d21c5e57fd476996ac9b7cc835af603`. Both repaired observer tests execute and pass:
app 46 PASS/64 SKIP, followed by memory full-stack seven PASS. Every required Branch lane,
including static checks and fresh validation publication, succeeds. The actual
`validation-evidence-v2` record matches repository, PR633, run37404814266/attempt1, full
a74 head and independently reconstructed build digest
`42da38f04c49ea9227abeac8088c43449da154d2aa70ed23ae6ad23942dd6eb3`.

Current downloaded artifacts contain 101 passing recipe reports across seven matrices,
with zero blocking failures and 192 declared nonblocking failures (Branch88, Formation104,
Medium0). Five event histories/four result-store reports remain truncated. Hosted units
pass 14,661 tests; their 12 SQL skips receive separate dedicated PostgreSQL coverage.
App/Recipe Console/ALM skips and conditional broad-mode RTC integrity remain explicit.
This accepts current normal correctness only; original post-ICE cause, target-native
availability, observer cost, full distributed application, B06/E1/E3/B07 and the broader
goal remain outside this checkpoint. Task57 may now start its first semantic regression.
No Issues were created or reused.

The first inline proposal assumed that a pre-send `rtcCapture()` getter could certify
message application. Source tracing disproves that: message acquisition awaits auth
reconciliation and can replace the getter's graph. Page-generation leases do not identify
that SDK session or middleware. Reading a new receipt afterward cannot certify the old send.
This prerequisite therefore precedes distributed receipt aggregation. A focused refresh also
locates separate Connect/live-CRDT attribution gaps: the page Connect bridge erases middleware
success before later global readback, while live document diagnostics read the global receipt
after opening/reading the document. Existing SDK/page guards precede further callbacks and
do not establish terminal graph attribution. Page-owned authentication remains serialized;
no executed replacement race is claimed. Their original-owner, test-first readback correction
is the next slice. Guarded reference bodies, restore/replay and runner materialization remain
required later outcomes.

Extend the existing message input with the canonical optional `rtcCaptureMode` and
`rtcCaptureContext` members from `RallarOperationOptions`; do not add another resolver or
selection field. Route that snapshotted intent through the original authenticated acquisition.
No-intent callers retain owned active/pending acquisition. Explicit incompatible mode retains
the existing typed refusal, with no automatic reconnect or extra constructor.

Expose `RallarMessageHandle.rtcCapture()` returning the canonical
`RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>` associated with that
handle's acquired graph. The original transport owner supplies the receipt only for the
captured middleware/session. The existing sender/delivery/admission owners fence identity after
ID/clock/diagnostic callbacks and before enqueue. Required explicit capture cannot admit a send
using unavailable, mismatched or noncurrent application evidence; connection initialization
keeps its original business result. A handle never reads a later global replacement as its
own receipt. Preserve original origin on compatible reuse, truthful unavailable results,
current message lifecycle/fallback/deadlines and all capture/resource caps.

Semantic TDD must first show ignored explicit intent admits the wrong mode, or admits an
incompatible send, through the actual SDK queue port. Cover auth replacement during acquisition
and after acquisition in synchronous creation callbacks, plus sink-unavailable refusal,
compatible reuse, Off without events and unchanged ordinary sends. A missing new method alone
is not the behavioral RED. The page WS adapter forwards accepted intent and exposes this actual
handle receipt; distributed DTO/compaction/restore work remains outside this prerequisite.

Run focused sender/session/delivery/actual browser application tests, then shared-web/shared-test
and maintained test types, public API snapshots, browser entrypoint/bundle boundaries and
required affected app builds. Full recursive standards closure and independent specification/
quality review remain binding. Before broad validation root runs delivery status and updates
prose before one coherent freeze. No new producer, retry, timeout or performance acceptance.

### Task 57: Fenced Connect operation readback

**Status:** Corrected Connect is independently reviewed and locally accepted. Witnessed
semantic RED precedes each production correction. The former internal-result consumer
expectation and its full-file standards findings are corrected; the justified full-unit
repeat and affected consumer validation pass. Published corrected Connect now passes its normal
hosted delivery gates with actual source-tree reconciliation. Concurrent live-CRDT working
changes are outside that hosted evidence; native/performance baseline acceptance remains open.
Connect and live CRDT remain distinct completion/effect
owners with separate slices. The earlier inline distributed draft remains deferred.
Root owns the plan, port binding, Git and publication.

**First regression checkpoint:** Valid no-room Connect, with authored run Off and real
SDK/page/SPA composition, returns recipe success and an `rtc.connect` child with status
`ok` after its phase-completed callback synchronously closes the page. The original receipt
and close preconditions pass; four assertions fail on actual success, connected/applied
publication and missing canonical serialized refusal. Root reads the complete terminal
RED and non-reentrant Off control (one PASS), then independently verifies that only the
test and root plan differ from a74 before releasing production. Source tracing confirms
that close increments generation and aborts the operation immediately; resource cleanup
waits for the active Connect Promise. Delayed cleanup does not keep the lease current.
The earlier no-room readiness option made that measurement oracle ambiguous; its logs
remain preserved and excluded from readiness proof. Valid measurement coverage is separate.

**Bound first port:** Preserve one accepted middleware/readout pair under the original
transport/session completion owners and their original pending reservation. The existing
internal session exposes `connectWithRtcCapture`, while public `connect` and existing
ordinary acquire consumers retain `Promise<ApiMiddleware>` through projection. The
advanced page dependency's existing `connect` returns the canonical capture readout;
the page attempt retains it before callbacks and uses it for results/refusals instead
of later global readback. The demonstrated ended page lease is translated through the
existing canonical refusal with additive `operation-not-current`, preserving SDK
session/middleware reasons. No auth loss is inferred from page generation loss. This
first correction has focused GREEN and remains subject to independent review; further
SDK reentry, Native eligibility, read/terminal callback and measurement boundaries
require their own meaningful regression evidence.

**First GREEN checkpoint:** The valid phase-callback regression and actual non-reentrant
Off control pass. Covering Connect/lifecycle, command/cancellation/cleanup, acquisition/
Native-construction and public-surface groups pass 252 tests across 22 distinct files;
the selected two tests overlap that total. Shared-web/shared-test types and the maintained
test checker pass (1,464 files, zero debt/errors). Changed style, structure, formatting and
whitespace checks pass. Focused style reports 138 warnings; the implementer reviews full
touched-file closure, while independent untouched findings remain outside this change.
The command boundary initially lost the canonical refusal details after the page fix;
a strengthened JSON regression fails before the narrow existing-error decoder correction,
then passes. These results accept only the demonstrated correction, not all Task57 outcomes,
native performance, broad validation or publication. The earlier raw test-project typecheck's
external library/cache typing failures remain disclosed separately from semantic RED.

**Next callback RED checkpoint:** Test-only real SDK/page/SPA scenarios show that a
late lane-health read can close the page before successful completion (four actual
result/refusal failures), and the terminal completion callback can close it before a
successful result returns (three failures). Genuine original Off/run receipt and closure
preconditions pass. The causal terminal event remains valid historical evidence; its
absence is not required. An earlier phase-status-read variant already passes, as do the
original two controls. Root fully reads the terminal outputs, tests, owner and bounded
report, then independently verifies all twelve held code/support hashes and HEAD/index
before releasing two checks at the existing result-read/publication boundaries. Document
injection still needs a fixture hook and has not been tested; these failures do not prove
SDK auth replacement, Native eligibility or valid measurement coverage.

**Next callback GREEN checkpoint:** Two calls to the existing currentness check now fence
the assembled result before completion publication and the returned result after that
publication. Five selected cases pass, including the valid historical terminal event and
earlier controls; they overlap the full 11-file covering run of 126 passing tests. Shared-test
and maintained-test types, owner/changed style, formatting and whitespace pass. Root fully
reads this bounded report and terminal evidence and verifies that removing exactly the two
checks recovers the first-GREEN owner hash; the witnessed tests and eleven other changed
code/support files remain byte-identical. These counts describe this current correction's
scope and are not added to the overlapping earlier 252-test total. Task57 remains open.

**SDK/Native RED checkpoint:** Actual authored Native without a sink constructs a successful
SDK graph and a genuine unavailable-application receipt, yet required page/recipe Connect
reports success. A real SDK lifecycle clock callback also ends the auth session after graph
acceptance while required Connect reports success with its genuine historical Off receipt.
Each case fails four observable result/refusal assertions. Applied Native/partial, separate
document-close, original phase-close and non-reentrant Off controls pass. The initial assumed
late auth-expiry site was wrong; its hard assertion is excluded and retained with the observed
earlier WS lifecycle notification trace. Private stack-name test assertions are removed; the
final RED uses receipt, connected state, reentry and ended-session facts. Root fully reads
the report/terminal output and independently verifies all twelve held code/support hashes
and HEAD/index before correction. Specific late expiry and graph replacement remain unproved.

**Bound eligibility projection:** The existing advanced Connect completion will retain the
original readout together with a closure delegating original-middleware currentness to
`BrowserSessionDeliveries.captureOwnershipFailure`. Its associated canonical completion type
replaces the bare advanced readout; public SDK business results and the transport/session
pair stay intact. The page attempt keeps that single immutable completion and uses the
existing finite receipt validator and refusal serializer at its direct eligibility guards.
No copied ownership algorithm, new store/reason union, global receipt lookup or legacy shape
bridge is selected. The new Native RED also earns correcting the touched tests' obsolete
successful-required-unavailable setup while preserving SDK construction and refusal coverage.
**SDK/Native minimum GREEN:** The same implementer returns the immutable advanced
completion with the original readout and the existing original-middleware ownership
predicate. Required page diagnostics now refuse actual unavailable Native application
and the demonstrated ended SDK session; applied partial Native and ordinary omitted
intent remain preserved. No public business Connect, construction, cleanup or identity
policy changed. The first verification attempt incorrectly observed construction after
normal failed-recipe cleanup; its failed log is retained. Real completion and refusal-time
observations correct that test timing while preserving all semantic refusal assertions.
The existing absent-receipt consumer now expects required Native's canonical refusal and
separately preserves omitted-intent success; the obsolete successful-required-unavailable
WS prerequisite is removed with its finite JSON purpose covered by the actual refusal.

Root fully reads the bounded report and complete terminal logs, independently verifies
the five current-phase changes, nine unchanged earlier owners, unchanged HEAD/index and
retained RED log hashes, then freezes the report. Focused checks pass **266 tests across
23 distinct files**; selected six overlap. Maintained types enforce1,464 files with zero
debt/errors; public snapshots/browser boundaries, explicit-base structure, changed style,
format and whitespace pass. Two Node localStorage warnings and the reviewed cohesive
test-suite load57 warning remain explicit. These counts overlap earlier phases and are
not added. Whole Task57 acceptance and independent review remain open.

**Final boundary witness:** Against that frozen minimum GREEN, actual SDK-clock page
closure passes its construction/receipt/ended-lease preconditions but loses the canonical
refusal and historical evidence at the immediate raw page-currentness check. Two actual
command/page JSON assertions fail; the complete module returns1 FAIL/32 PASS. Real SDK
replacement across the room service response already refuses middleware-not-current with
the original readout, despite a distinct latest replacement receipt and unchanged auth
session. Both valid room-targeted measurement variants pass: closure prevents readiness
start, while the non-reentrant control starts actual readiness and truthfully times out
with no ready peers. This is measurement-start coverage, not live room/network acceptance.
The first control's incorrect event-field expectation is retained and excluded from RED.

Root fully reads the report, complete terminal output, actual tests and owner, then
independently verifies13 held hashes, exact original test recovery, retained GREEN logs
and unchanged HEAD/index. Minimum GREEN is released only to replace that immediate raw
check with the existing typed eligibility guard after retaining the SDK completion. The
guard, SDK policy and passing room/measurement boundaries receive no speculative changes.
Specific late-auth-expiry timing is neither inferred nor forced. Task57 acceptance and
independent review remain open; Task58 follows Connect acceptance.

**Task57 review freeze:** That exact single guard-call replacement passes selected4 and
covering135 tests across12 files, including all33 capture cases; counts overlap and are
not added. Package and maintained types, changed style, explicit-base structure, formatting
and full owner closure pass. Root fully reads terminal evidence and independently restores
the prior owner hash by undoing only that call, verifies twelve held owners, unchanged
regression/RED logs and unchanged HEAD/index, then freezes all14 code/test hashes. A fresh
independent reviewer receives the whole Task57 diff with complete touched-file context for
specification and quality review. Broad consumer validation and source publication remain
pending. Task57 and the goal remain open; no native/network/performance acceptance follows.

**Independent review and fix round1:** Complete14-file specification/quality review returns
C0/I1/M1. I1 identifies the raw page-currentness check after awaited room join, which loses
required canonical refusal and the original receipt when the page closes during that await.
The new actual SDK/page two-variant regression produces1 semantic FAIL/34 PASS across35
cases: genuine Off/run receipt, accepted construction and ended lease preconditions pass;
only two command/page refusal assertions fail. Omitted intent preserves ordinary cancellation.
Root fully reads the report/output/test and independently verifies13 held hashes, exact prior
test recovery and retained GREEN evidence before releasing only the existing eligibility call
at that return boundary, with removal of its unused context binding. Scoped independent
re-review follows focused GREEN; broad validation stays held. M1 records the existing two
Node localStorage warnings as nonblocking, with no warning suppression or unrelated cleanup.

**Fix-round1 acceptance:** Only the post-room eligibility call and unused local binding
change; every regression byte remains unchanged. Selected6 PASS overlaps covering137 PASS
across12 files, including all35 capture cases. Types/style/structure/format pass. Root fully
reads terminal evidence and independently restores the exact reviewed owner by undoing those
two lines, verifies13 held hashes and retained RED evidence, then freezes14 current paths.
Scoped independent re-review marks I1 ADDRESSED, specification PASS and quality APPROVED,
with no new fix breakage. Combined with the original whole-task review, no Critical or
Important finding remains. Root now selects one full unit run, affected package checks/four
consumer builds and the real Black Box browser suite; broader results are not yet accepted.

**First broad-unit outcome:** Frozen source yields1 FAIL/14,675 PASS/12 SKIP across1,497
files. The only failure is the unchanged pending-initializer cleanup test: it calls the internal
session lifecycle directly but expects the former top-level middleware session, whereas the
accepted result now retains middleware and readout together. Public Connect still projects
middleware. Root completely reads the failure, original666-line test and read-only old/current
diagnosis, verifies14 frozen hashes, then releases only nesting that existing expectation under
middleware. Its later old-initializer cancellation and active new-session assertions were not
reached and remain unchanged acceptance requirements. This is a consumer expectation correction,
not a new product semantic RED or TDD waiver. The additional touched test enters full standards
closure and scoped independent review before one justified full-unit repeat. Four affected app
builds pass with existing Vite chunk advisories; actual browser-suite results remain pending.

**Consumer and standards closure:** Nesting the internal result's exact session expectation
under `middleware` preserves every later cancellation/current-owner assertion. The selected
scenario and all14 cleanup cases pass. Independent full-file review accepts that adaptation
but identifies the meaningful anonymous Web Locks fixture output and import-group layout.
A private `GrantedWebLocksFixture` beside its helper and external/workspace/local import
groups close those findings without changing executable fixture bodies or assertions.
Root independently reconstructs the accepted consumer bytes, verifies all14 earlier frozen
paths and retained RED/GREEN/failure logs, then fully reads scoped re-review: both findings
ADDRESSED, specification PASS, quality APPROVED, no new fix breakage. Checker silence was
insufficient; the earlier incomplete full-file closure claim is explicitly corrected.

**Local broad acceptance:** The single justified full-unit repeat returns exit0 with
14,676 PASS/12 SKIP across1,497 files (1,493 PASS/four SKIP). The original1 FAIL/14,675 PASS
run remains retained as failure evidence. Maintained test types enforce1,464 files with
zero debt/errors; shared, shared-web and shared-test types pass. Previously focused public
snapshots/browser entrypoint checks remain valid. Fresh post-standards changed style passes;
structure, formatting and whitespace pass. Scoped cleanup style has eight independent
untouched-file prompts and no touched-file finding. Every changed human-authored file was
reviewed and remediated in full; support modified by remediation enters closure recursively,
and independent untouched code remains outside closure. No additional support changed here.

All four affected builds pass: Black Box UI, headless, AR Eye Hunter and Relic Hunters.
The actual Black Box browser suite returns exit0,46 PASS/64 SKIP; both observer cases pass.
Full coupling registry validation and reachability pass (1,767 files,1,761 CI-reached/six
manual); the actual changed-commit coupling gate remains a pre-push requirement. Existing
Node experimental-localStorage and Vite chunk advisories remain disclosed. Root verifies
all15 accepted code/test hashes unchanged after validation. The support-only correction
does not justify repeating the already-passed app suite/builds. New-head hosted correctness,
live CRDT, native/performance and baseline/cohort acceptance remain separate required evidence.

**Hosted Connect acceptance:** Actual checkout and artifact source markers reconcile the
published Connect head with identical Formation/Medium merge trees. Branch, Formation and
Medium gates all succeed on their original attempts. Hosted units match14,676 PASS/12 SKIP;
app46 PASS/64 SKIP, all four observer cases and memory7 PASS execute. Public/bundle/static/
build/PG checks pass. All101 recipe matrix rows and primary summaries reconcile with zero
blocking and206 explicitly nonblocking failed steps retained. Five event histories, four
result lists and three result stores are truncated; omitted row detail is unavailable.
Dependent capture transforms fail after missing WebSocket expectation matches, with no
stronger product/infrastructure cause established. These normal checks do not validate
uncommitted CRDT work, native performance or the incomplete B01–B06/E3 acceptance.

Connect must preserve actual immutable capture evidence from its own acquired graph
through the existing page result boundary. At published a74, the transport creates a typed
middleware/receipt pair, but acceptance projects only middleware and the page bridge erases
that completion before later global receipt readback. The first correction carries the
accepted pair through the original transport/session reservation and retains its readout in
the page attempt. Additional lifecycle/state/clock, diagnostic-read and terminal callbacks
still require concrete currentness evidence before further correction. Controlled real SDK
replacement across the room service response now preserves refusal with the original receipt;
this does not prove a live server or network race. Existing serialized page authentication remains a
positive preservation baseline.

Required outcomes:

- Snapshot accepted canonical intent at the existing operation boundary. Use the accepted
  resolver and finite refusal contracts; do not add another selection or reason union.
- Capture the original graph readout before reentrant callbacks and carry that immutable
  value through completion. A later global replacement never certifies this operation.
- Verify required diagnostic eligibility after callback-capable reads and before the
  next required measurement/result effect. Preserve genuinely captured historical evidence
  when currentness fails; report canonical finite unverified facts through existing typed
  page/error serialization rather than inventing applied evidence.
- Preserve public `connect(): Promise<ApiMiddleware>` business success, original errors,
  reservation/cancellation, ordinary no-intent reuse, compatible receipt origin, lifecycle,
  retries and deadlines. Native partial availability remains distinct from unavailable
  application. Diagnostic refusal does not tear down or fail successful native construction.
- Prefer the existing internal middleware/receipt pair through original transport/session
  completion and the advanced page composition. Before minimum GREEN, root binds the exact
  port from the meaningful failure and actual consumers. No new owner, store, recorder,
  generic property walker or mandatory public receipt field merely to expose diagnostics.

The executed first candidate uses real SDK-backed page composition and authored Off:
an existing phase-completed diagnostic callback closes its page synchronously. A required
Connect must not certify successful application after that lease ends. Preserve its actual
original receipt in refusal and the passing non-reentrant Off control. Subsequent valid
measurement/currentness cases must use their own actual effects; if already protected,
report that truth and trace the next concrete boundary. Missing new methods, invented
receipt fixtures, malformed inputs and compiler/setup errors do not earn RED.

The implementer loads the selected current skills and required references before source
decisions and reads nearby owners/tests/examples. Before each distinct correction, it
writes/runs the semantic regression to terminal completion, reads its full output and stops
before production or support-policy edits. Root independently reads the meaningful failure
and verifies unchanged production before minimum GREEN. Further corrections retain this
witnessed RED requirement.
Non-reentrant actual Off, compatible origin, Native partial/unavailable distinction,
ordinary no-intent behavior and serialized page auth need positive preservation evidence.
Actual page JSON success/refusal must retain operation attribution.

Focused Connect/acquisition/lifecycle/page tests precede package and maintained-test types.
Public snapshots/browser boundaries/budgets apply if exported shape changes; affected
consumer builds follow the testing skill. Full touched-file standards closure includes
every recursively changed support file; independent untouched source stays outside.
Root selects coherent frozen broad validation and independent specification/quality review
after focused GREEN. No new producer, retry/deadline change, cap expansion, legacy retention,
Issue, deployment, distributed aggregation or baseline acceptance is authorized here.

### Task 58: Fenced live CRDT operation readback

**Status:** The first application-admission checkpoint at the black-box runner's
existing-connection branch is locally accepted after genuine RED, focused GREEN and
independent review. Its newer code is outside the previous Connect head's hosted evidence.
Task58 is incomplete: the initial-live currentness checkpoint has independently witnessed
genuine RED and a bounded four-file correction.
Its focused validation is GREEN and full touched-file closure is documented; fresh independent
review returns SPEC PASS and QUALITY APPROVED for the frozen six-file working-tree diff,
with one minor passing-test logging finding. Broad working-tree validation is GREEN,
including the actual changed-style gate after scoped independent approval of its exact
raw-Error test-boundary classification. The reviewed initial-live checkpoint is published as
`431a77b93ccae63d7ca7ad8869838086e1201967` in the existing draft PR and passes its three normal
hosted gates with source/artifact reconciliation. The acquired-send successor has independently
witnessed genuine RED. Its two-owner transient startup correction has independently witnessed
focused GREEN against frozen tests. Its I1 review identifies a refused document unreachable
by ordinary cleanup after subscription creation. Correction round3/5 earns resource and reached
cleanup-error TDD, then document-only functional GREEN. Fresh scoped review accepts literal
disposal and closes I1/M1, while QUALITY remains NOT READY for I2: encryption's returned carrier
cannot truthfully satisfy the public arbitrary TPayload promise. A concrete public typing
proposal awaits maintainer approval; source/test/API expansion is held. Full acquired-message
readback and later operation/configuration boundaries remain incomplete.

**First RED checkpoint:** The actual connected SDK returns its original Native/run receipt
with unavailable/sink-unavailable application and current middleware ownership. Required
page CRDT open discards that completion, constructs the actual document, admits initial
catch-up/sync messages through ordinary dispatch and publishes opened success. The complete
41-case owner returns1 FAIL/40 PASS: three actual refusal/admission/publication assertions
fail, while five applied/ordinary/local/HTTP controls and all35 previous cases pass. Original
message handles retain the same receipt and admission timestamps. Queued/not-ready lifecycle
evidence proves admission, not physical transmission or remote delivery. Native coverage
remains truthful; this is not a native/performance result.

Root fully reads the report, complete failure/control output, relevant controller/resource
owners and canonical validator, then independently verifies all267 unchanged runtime files,
exact recovery of the previous35 cases and unchanged HEAD/index before releasing production.
Maintained types pass1,464 files with zero errors; adjacent transport/command/lifecycle tests
pass49. Earlier invalid control/defaults/ref/type attempts remain retained and excluded from
semantic RED. Existing fixture construction is reused in place; no support extraction occurs.
The complete touched test is reviewed, including its six-symbol import correction; it remains
coherent at1,469 physical lines and cognitive score89. Full-file and recursive support closure
remain binding, with independent untouched source outside.

**Bound first correction:** Only the cached/no-nested-API branch of the black-box CRDT
controller retains its actual advanced Connect completion and checks explicit required
application through the existing canonical intent/receipt validator and finite error before
opening the live document. Original receipt, ordinary omitted intent, local persistence and
HTTP controls remain unchanged. No CRDT engine, merge/persistence algorithm, SDK policy,
fresh bootstrap, deadline, retry or global diagnostics-projection change is selected by this
RED. Distinct later corrections require their own failing behavior before production edits.

**Accepted minimum GREEN and standards closure:** The unchanged first regression and
five controls pass6 selected cases, the complete owner passes41, and the first proportional
caller set passes111 across seven files. Independent review accepts the application gate
but finds a four-positional publication helper and a weak existing recipe-run WS test;
subsequent full-file inspection finds the same signature violation in projection. Named
class-owned inputs close both signature violations while preserving all10 projection and
12 publication call values/order and helper behavior. The recipe test now proves the
failed WS command and canonical Off/run incompatibility against its original applied
Native/step receipt, rather than accepting any failure. No serializer or other runtime
correction is needed. The intermediate nested partial-matcher failure is retained and
excluded from product RED.

After that correction, the strengthened WS case passes1, the owner passes41 and four
controller callers pass59. Shared-test/shared-web types, maintained1,464-test types with
zero errors, formatting and whitespace pass. Scoped independent re-review reports all
three findings addressed, SPEC PASS and QUALITY APPROVED. Controller788 physical lines
and cognitive129 retain one command/resource capability; its47/54/47-line functions have
explicit separation judgments. Test1,513 raw lines minus504 authoritative behavior-free
literal lines is1,009 effective lines, below its1,500 backstop; cognitive89 remains cohesive.
No size exception, support extraction or compatibility retention is required.

Root verifies the accepted gate, six new cases, fixture and all other old cases remain
exact; all266 unreleased runtime owners and41 frozen evidence files remain unchanged.
Original RED, invalid attempts, first GREEN and the earlier incomplete closure judgments
are preserved. These local results approve only this runner application-admission
checkpoint; they do not establish full Task58, native availability, wire delivery,
distributed behavior or baseline performance. No Issues are created or reused.

**Second RED checkpoint: original-session eligibility during hydration.** A real public
SDK replay-metric callback invalidates authentication after the runner's application check.
The original Off/run receipt is actually applied and its connected session is current
before the callback; its original ownership then reports `session-not-current`. Actual
update, sync-request and catch-up-response receive subscriptions nevertheless register
before an ordinary no-auth send error. The complete owner returns1 FAIL/44 PASS: canonical
original-receipt refusal and initial subscription eligibility fail, while no opened success
is published. Three controls with the same instrumentation preserve applied Off, applied
Native with truthful partial coverage, and omitted intent; all41 earlier cases pass.

Root fully reads the complete report, failure/control output and test delta, independently
verifies all267 runtime owners unchanged, and reconstructs the entire previously accepted
test byte-exact by removing only the new cases/types. All89 immutable prior artifacts stay
exact; the explicit observer clarification is separately accounted. Maintained1,464-test
types with zero errors, shared-test types and formatting pass. The existing owner remains
cohesive at1,121 effective lines and cognitive119 after a required separation review.
Invalid selection/type attempts remain retained and excluded from semantic evidence.

This trigger adds the supported public SDK metrics sink to the delegated real open call;
the page decoder does not expose raw recipe metrics. Explicit unsubscribe cleanup in finally,
outside the metric callback, proves test hygiene, not product cleanup after failed hydration. The RED earns only
original-session refusal before initial live subscriptions. Exact necessary owners and
ports follow current source inspection before minimum GREEN; per-send/readback, engine
merge, persistence, retry/deadline, raw recipe metrics and distributed/performance changes
are not selected by this failure.

**Why this touches SDK CRDT:** Live recipe documents use the Rallar connection whose diagnostic
capture they require. The runner's check before document open is too early: a real SDK
callback during loading can end that session before the document registers subscriptions.
The SDK document owns that registration point, so the bounded correction passes an internal
original-session admission capability through the existing runner composition and facade
into hydration, immediately before initial tab/live resources register. Its four existing
owners are the black-box CRDT controller, browser runtime composition, browser CRDT facade
and browser CRDT document. Public CRDT options and barrels remain unchanged.

The facade's larger diff replaces its existing stateful cache factory and five-parameter
plumbing with explicit same-file lifecycle ownership, as required by touched-file standards
closure. Full review also identifies caught-value normalization in the already touched
document; its own public-SDK semantic RED proves two primitive-error leaks, with four
passing controls. Canonical normalization now preserves actual Error identity, messages,
failed-update metadata and authored readback. The admission check protects required
diagnostic verification; the additional facade and Error changes close touched-file standards.
They do not change the CRDT engine, merge or
persistence algorithms, and they do not diagnose or fix the initial post-ICE RTC stall.
This initial-live checkpoint is locally and normally hosted accepted at the published head.

**Current scoped GREEN:** The original-session capability is passed only for initial hydration,
so the document does not retain the original completion for its lifetime. The frozen Error
owner passes6, the hydration family passes4, the complete recipe owner passes45, and existing
SDK/runner callers pass75. Public API/entrypoint/browser boundaries pass32; both package types
and maintained1,465-test types pass with zero errors. These selections overlap. Pure expected
reference/scope validation now returns canonical Either; public open preserves its deliberate
Error refusal and original field/effect order. The existing malformed-open group passes8,
including missing principal/custom/room identities before SDK open.

Formatting/whitespace pass; warning-only style output is paired with full manual closure and
function/file separation judgments. The current controller's54-line open and54-line poll,
facade58/59-line lifecycle/translation functions and document54-line constructor have explicit
separation reviews; no function exceeds60. Root independently freezes the complete report,
six-file diff, all268 held runtime/test files,27 earlier final artifacts and20 current scope
artifacts, preserving both original RED reports and all prior evidence. An invalid read-only
inventory candidate and the root's incorrect byte-identical style assumption are retained as
tooling findings: corrected inventory passes, and the style delta contains only five shifted
source locations. They are not semantic RED. No public contract, retry/deadline, cap, engine
or persistence algorithm changes follow from these checks. Native and performance acceptance
remain unproven; hosted evidence for the published checkpoint cannot certify newer test-only
work or full Task58. No Issues are created or reused.

Independent review traces original middleware ownership, transient admission, extracted generic
open, cache/close ordering, typed validation and Error identity through the actual code. It reports
no critical or important finding. Its one minor finding is five unconditional diagnostic dumps
in the touched recipe test. They remain visible in the preserved output and are deferred to that
owner's next refactor or final review; this is no waiver for a standards violation. The review
explicitly leaves fresh/configured admission, acquired-send/result attribution, later global
projection, cached resubscription, failed-hydration disposal and baseline acceptance unproven.

**Broad checkpoint validation:** Bare `npm test` passes14,692 tests with12 skipped across
1,498 scheduled files (1,494 passed/four skipped). All four affected consumer builds pass:
AR Eye Hunter, Relic Hunters, Black Box and Black Box Headless. The actual Black Box browser
suite passes46 with64 configured skips, including both observer cases and four native
answer/deadline controls. Its live full-stack/configuration-dependent cases remain skipped;
these results do not certify live distributed CRDT or B06. Shared-web bundle checking passes
at246.8 Brotli KiB against the unchanged247 browser ceiling. The existing full-unit headless
boundary test checks forbidden imports and the unchanged317 Brotli KiB ceiling; auxiliary
readback of its retained bundle measures316.524 KiB without a rebuild. Reachability and
structure pass. Full-repository style exits0 with3,461 nonblocking findings; that warning-only
inventory does not replace the accepted touched-file reviews. Existing Node localStorage,
Vite chunk and browser color-setting warnings remain disclosed.

The first actual changed-style invocation fails only the Error test's raw rejection/logger
observations. Normalizing those assertions would conceal the primitive leak. The existing
immutable browser disposition inventory now records exactly that file, `boundary.unknown`
and its absent checker symbol. All108 prior entries and their byte order remain exact; no
matcher, threshold, wildcard, numeric cap or runtime/test changes accompany the addition.
Existing classifier/negative controls pass86, the frozen Error owner passes6, and the actual
changed-style CLI passes against the same base. Scoped independent re-review reports D1
addressed, SPEC PASS and QUALITY APPROVED. Another future occurrence under the same module
key would also match, so touched-owner human re-review remains required; this classifies a
legitimate observation boundary and is not a real standards exception or legacy retention.
The support correction is cumulative fix round2/5; M1 remains explicitly deferred. Original
failure and all frozen runtime/tests/evidence remain retained. No Issues are created or reused.

**Published initial-live hosted acceptance:** All three original attempt1 runs finish success
for the exact published head: Branch37433251129, Formation37433250674 and Medium37433250661.
Actual Branch jobs check out the head; Formation/Medium check out their synthetic merge with
the identical source tree. Canonical validation-evidence schema/identity/committed-tree digest
pass. Eight original ZIP digests and753 extracted files match. Hosted units reconcile14,692
PASS/12 SKIP, including all45 published recipe cases; app46 PASS/64 SKIP, memory7 PASS and
four native observer cases execute. Recipe Console shards pass109/90 with9/3 skips; PG
integration85, smokes4+1 and presence10+10 pass. Current static/types/consumer builds pass.
All101 primary recipe summaries and seven matrices reconcile with zero blocking and192
explicitly nonblocking failures. Missing overlay WebSocket matches precede dependent capture
transforms; that chain does not establish a product-versus-infrastructure cause. Five event
histories, four result lists and three stores have declared omissions. ALM smoke cells pass
but each has one sample and too-few-samples, retaining HTTP conflict/malformed-RTC warnings.
This is normal published correctness, not B06/E3, a performance comparison or successor proof.

**Acquired initial-send RED:** A five-case family delegates real SDK send, awaits actual
canonical catch-up admission and retains the genuine handle's immutable receipt/history.
An outside callback performs supported disconnect/connect with the same required Off/run
configuration. The replacement has a distinct observed connection identity and current
ownership; the original becomes `middleware-not-current`. Its admitted handle/history stays
unchanged. Current initial open nevertheless admits a subsequent sync-request on the replacement,
returns opened/sent health with that latest global receipt, publishes opened and omits canonical
original-refusal JSON. Four semantic assertions fail, while four same-instrumentation applied
Off, partial Native and omitted-intent controls pass. Final selected1 FAIL/4 PASS and complete
owner1 FAIL/49 PASS preserve all45 previously accepted cases. Queued/admitted states do not
prove wire transmission or delivery.

The first five-failure candidate lacks admission/control preconditions and has two timeouts;
it is retained and excluded as invalid setup. The corrected external hold/release and actual
handle wait earn the final RED without timer, deadline, retry, fixture or runtime changes.
Types pass1,465/0 and shared-test checks/format pass. Full test review records1,275 effective
lines and cognitive146 for its same coherent evidence owner; M1 stays deferred and new tests
add no passing logs. Root fully reads complete report/392 selected/425 owner lines and verifies
269 held files,215 prior artifacts, four accepted reports,19 fresh evidence files and nine
terminal logs. Removing the three additions recovers the old test byte-exact. All267 runtime
owners remain unchanged at the RED checkpoint. The completed source-only investigation selects
the existing hydrate-to-live-start admission capability: recheck after durable WS before HTTP
fallback or sync, after HTTP when invoked, and after live startup before success. This transient
two-owner correction is released with all 50 test cases frozen; it retains no original completion
for the document lifetime. A final-result guard alone leaves the demonstrated later admission
possible. Live-sync's concrete Options/interface and type-only import receive full touched-file
closure. The fresh entry audit verifies all 270 files before release and freezes the other 268,
215 old artifacts, four accepted reports and the original RED. The 19 digest-recorded RED files
plus their separate handoff witness make 20 matching files; earlier records are not rewritten.
This is a startup guard checkpoint, not the required finite per-message result retention.
The literal family now passes five cases and the complete unchanged owner passes 50; Error6,
existing five-file callers75 and adapter8 also pass. All 15 validation invocations terminate
exit0, maintained types remain1,465/0 and both package types/format pass. The directory style
reports 12 findings in independent untouched owners; full two-owner review records constructor54
cohesion and live-start13 lines. Root reads the complete report/raw outputs and verifies all
frozen records plus 23 fresh GREEN evidence files and exact whole-source inverses. No test,
fixture, deadline, cap or M1 logging change explains GREEN. Independent review confirms I1:
WS detach preserves registered listeners, which reattach on replacement; the failed document
can answer later matching sync requests, and enabled tab channels remain open. The facade/page
store documents only after hydrate resolves, so neither can close this refused owner. This is
a source-derived consequence at that review checkpoint. Root fully reads the review
and verifies the actual ownership path. Those tests manually unsubscribe and disable
tabs/persistence, so their GREEN does not prove product cleanup. The separately released
resource reproduction first removes exactly five M1 dumps and preserves50 GREEN. Its final
five-case family returns1 FAIL/4 PASS; the complete owner returns1 FAIL/49 PASS. The required
refusal retains its actual channel and five subscriptions, admits a later sync response through
the real replacement inbox, receives a peer tab update and persists peer state. All observations
precede test cleanup; current/ordinary controls apply the same real WS/tab stimuli and public
close suppresses subsequent effects. Authored title/marker survive public persisted reopen.
The count-only tab observer keeps raw values out of test state. The persistence assertion
proves an abandoned-owner effect after completed real WS delivery, not exclusively a tab write.
Invalid seed and premature concurrent-listener attempts remain excluded and unchanged.
Final maintained types1,465/0, shared-test types and formatting pass; the coherent owner has
1,422 effective lines/cognitive187 after full-file closure review. Root fully reads final
failure/control output and verifies all269 held files,276 historical records,49 fresh evidence
records plus their separate handoff,25 terminal command records and exact whole-test inversion.
All267 production owners remain frozen at that RED checkpoint. The subsequent cleanup-error
variant delegates the actual failed owner's tab close before raising one controlled Error.
Its pre-cleanup fault-reached assertion fails because product cleanup is absent; the canonical
refusal and acquired capture assertions still pass. The six-case family returns2 FAIL/4 PASS
and the complete owner2 FAIL/49 PASS. Root reads the complete changed delta and owner output,
then independently verifies596 held records,24 new evidence files, seven terminal commands,
eight whole-test inverse edits and the proposal's unchanged prefix. The51-case test is frozen
for the released minimum GREEN in BrowserRallarCrdtDocument alone. It must attempt owned
live/tab release and persistence close, preserve authored data and the original startup Error,
and use the named operational RuntimeFailure result at cleanup boundaries. Normal close's
new snapshot and destroy's deletion are distinct effects. This phase also resolves the same
document's expected closed-state check under touched-file standards closure. No lower-owner
cleanup guarantee, new public API or lifetime admission policy is earned. Focused GREEN and
scoped independent review remain required before acceptance/publication.
The document-only disposal successor is now functional GREEN: selected6/full51/Error6/
callers75/adapter8 pass, including the actual tab-close fault before test finally. All11
commands terminate exit0; maintained types1,465/0, package types and formatting pass. Root
fully reads the source/delta/report and final raw outputs, then verifies623 held records,
31 fresh evidence files, all11 command digests/line counts and11 whole-source inverse edits.
Normal successful lifecycle order, authored state and original refusal are preserved.
Full-file review nevertheless finds a retained internal cast from the protected base operation
batch to arbitrary TPayload. Encryption replaces the payload, while the public applyLocal
contract promises TPayload and a verified consumer requires returned ciphertext. Generic
identity or base-batch validation cannot prove that narrower payload. Quality is not ready:
independent scoped review and a concrete approved public compatibility disposition precede
any contract/support change. No approval for this new decision is inferred from earlier clock,
length or historical TDD approvals. No cast relocation, invented validation or retained-legacy
exception is selected.
The fresh scoped re-review returns literal disposal SPEC PASS and closes original I1 and M1,
while QUALITY remains NOT READY for Important I2. It independently authenticates the same11
terminal outputs and source/test identities, confirms release-attempt limitations and requires
an approved truthful carrier-output contract. The cumulative correction count stays3/5;
review does not reset it or authorize the next correction. The bounded compatibility proposal
is source-only; current public signatures and runtime encryption behavior remain unchanged.
The concrete proposal changes only the public contracts and browser-document owners:
caller-authored applyLocal input retains its declared payload, while applyLocal, generated
helpers and pending/failed/blocked outputs use the canonical RallarCrdtOperationBatch carrier.
Encryption can hide a caller-required operationGroupId; returning plaintext or moving the cast
would preserve the false promise or break a verified encrypted consumer. No migration,
compatibility wrapper, rename alias or retention exception is proposed. Maintainer approval is
requested for this exact source-compatibility correction; no public implementation is released.
Full Task58, subsequent readback/fresh/configured/cached/custom boundaries and baseline remain
open. No Issues are created or reused.

Snapshot canonical optional intent before hydrate/metric callbacks, verify original context
before required live effects, and retain each actual message handle's immutable evidence
through named transport/document/page result boundaries. A global latest receipt cannot
prove multiple effects or a later graph. Preserve document success, persistence, cached
reuse, ordinary omitted intent, HTTP/local-only behavior and existing lifecycle/deadlines.
Use existing document/session owners and finite contracts; custom absent evidence remains
truthfully unavailable. Required positive actual SDK controls must prevent blanket refusal
from masquerading as support. Exact ports and covering tests follow the selected failing
scenarios; inline distributed support/application aggregation follows these prerequisites.

### Task 59: Manual diagnostics selection

**Status:** Required by the approved diagnostics amendment; source audit and semantic RED
accepted. The corrected Inherit browser RED is independently witnessed and the bounded
six-owner implementation and earned default-room helper repair pass39 focused unit cases,
app typecheck and four-test types. Manual specification review conforms at the code boundary;
its invalid group-only Room Ref example is corrected. The separate Connect-to-Join forwarding
repair passes154 affected tests and independent specification review. Test-only provisioning
through the existing authenticated Rooms and clients action supplies the real group precondition.
The newly reached retained-export matcher is corrected to allow the legitimate sessionId while
still requiring both submitted modes. Final actual browser replay passes both cases, exit0,
including applied Off/native receipts, desired/current separation, recorded export, reload
and Reset. Scoped independent specification and quality reviews approve this bounded
Manual slice. The final import-only quality correction preserves every passing browser
body byte; no behavior rerun is required. Recipe Console and full amended acceptance remain.

At the source audit, the Manual draft/cache, rendered controls and direct Connect/Join builders
omitted capture mode. Existing immutable draft updates and redacted submitted-command history are
the owners to reuse. The canonical mode parser and connection receipt already exist; the UI
must carry the visible choice and display actual current evidence separately. Missing optional
saved preference inherits, with no format rewrite or setting alias. Reset must explicitly
cover the draft preference; the existing runtime Reset alone does not prove that behavior.
Recorded export must preserve the selection used even after a later preference edit.

**Inherited preference presentation:** The SDK's sink availability depends on resolved
application scope, and a previously owned configuration can remain the acquisition default.
The UI must not duplicate those policies or guess an effective inherited mode. Show Inherit
alongside the required Off/Signaling/Full native choices. Inherit translates to omitted input;
it creates no fourth CaptureMode, saved string, alias or migration. Actual effective application
still comes from the live getter. The new test's exact three-option list was stricter than
the approved requirement, which requires those choices but does not forbid omission's visible
representation. A test-only correction adds Inherit and its fresh omitted-preference oracle,
preserving all applied-receipt, desired-edit, export, reload and reset assertions. The real
focused browser run passes API readiness, login, visible Manual/Transport/enabled Connect and
initial saved omission, then fails at the absent selector: one failed case, child exit1.
Later option/readout/export/reload/reset assertions remain unreached. Root reads the complete
terminal output and verifies all four current test hashes, six unchanged production owners
and44 preserved evidence files before releasing the same six-owner GREEN scope.

The focused three-file unit run produces7 intended failures/31 passing controls: direct
Off/Signaling/native Connect and Off Join omit capture, cache loses Off/native, and recorded
export loses the submitted selections. All30 original cases and the omitted-saved-input control
pass. The repeated group creation guard is strengthened without changing its behavior.
The configured existing Postgres full-stack harness passes the old Manual case and reaches
real API/login/panel/Transport/enabled Connect in the new case, then fails at the absent capture
selector. A focused repeat at the corrected test bytes reaches the same missing selector.
The existing command history and Event Stream result path express applied Off/native evidence,
including truthful native coverage, but these later assertions and reset remain unexecuted.
Released-test types/format/whitespace pass. Prior reports/evidence and18 scoped production/support
owners remain unchanged. Only existing Manual command/action/cache and applicable visible-control
tests were changed for RED. The released production scope is existing values, commands, cache,
model, Inputs and Section. The live current readout belongs in a component mounted only under
Section's existing active boundary, with no hidden model timer or copied historical receipt.
Close/reset/replacement presentation follows the live active slot, including failed attempts
that leave an earlier connection current. Preference Reset clears the optional saved selection
through the existing draft owner. Fixtures/support and other production owners remain held.
The first implementation browser run passes the old Manual case and the new selector labels,
initial omitted/empty preference and current readout visibility. Its first completed Connect
result is failed: `Rallar command roomRef requires applicationId and groupId.` The complete
run is1 PASS/1 FAIL, child exit1. Source and actual failure-context correlation identify
`manual-workbench/manual-command-fields.ts::toDefaultRoomRef`, which emits only groupId;
the existing translator forwards that record and the canonical decoder correctly rejects it
before SDK acquisition. The old case checks broad action/export text and does not prove
successful Connect. Its PASS is not capture application evidence. Authorize the existing
default helper as the seventh production owner, with a focused default-scope regression before
its minimum repair. Use visible application/workspace/group values and preserve explicit Room
Ref precedence; do not duplicate fallback policy or relax routing validation. The existing
scoped test's historical type/id fixture is corrected to canonical explicit Room Ref data,
preserving its precedence assertions. Browser capture, current/desired, export, reload and
Reset assertions remain frozen. Whole added-file closure uses the existing JSON normalizer
instead of retaining its unchecked parsed-record cast. No new public API or migration is needed.
The default-room regression earns1 intended FAIL/16 SKIP before production; the repaired
three-file unit set passes39/39 and app/four-test types pass. The second real browser run
again reaches the selector and initial preference/readout checks but returns failed Connect:
`A new connection is required to change RTC capture mode.` It is1 PASS/1 FAIL, child exit1.
The retained error stack enters the SDK compatibility guard through public room join,
after the black-box operation's explicit connection stage. Source correlation identifies
`BlackBoxRallarConnectOperation::#openConnection`: the first call forwards its captured
rtcCaptureMode/context, but rooms.join forwards only timeoutMs/scope. Public join then calls
explicit session.connect, so the omitted selection resolves a different default and conflicts
with the owned Off graph. Initial login reuse is not the proved cause; changing test setup to
close first would conceal this operation defect. Release the existing runtime operation and
its existing recipe-rtc-capture-application.test.ts owner for semantic RED/GREEN of the same
captured mode/context across both stages, preserving omission, scope and timeout. The initially
suggested connection.test.ts double returns an absent receipt and cannot reach explicit join;
the existing lexical real initializer earns the replacement test owner without a copied fixture.
Two explicit cases fail at the missing join fields while the omission control passes; the repair
passes all3 cases and the nine-file154-test covering run. Independent specification review
conforms; quality review remains separate. No SDK policy copy, acquisition semantics change or
receipt-test workaround is selected. The seven Manual owners remain frozen for scoped review.
The invalid group-only Room Ref placeholder is separately corrected to a qualified example.
The subsequent unchanged browser replay is1 PASS/1 FAIL: the first Off Connect reaches the real
API, which rejects its uncreated fresh group with400 Group not found. Login never provisions
that group. This is a newly reached test precondition, not authority to change Connect behavior.
Release only the browser test's authenticated group creation through the existing Rooms and
clients UI, outside Manual command history, then return to Manual before direct Connect.
Preserve all receipt/current/export/reload/Reset assertions and the no-Configure requirement.
That provisioned browser replay reaches applied Off and Native but fails the retained-export
matcher: shallow objectContaining requires rallar to contain only the mode, incorrectly rejecting
the legitimate sessionId. Root reads the actual preserved Off/native commands before releasing
only nested partial matching. The final unchanged-behavior replay passes2/2 cases, exit0 after
13.582 seconds; every actual applied/current/export/reload/Reset assertion executes successfully.
No product behavior is changed to accommodate either test setup or oracle correction.
Final independent scoped specification/quality review accepts the frozen source and browser
contract. The only quality finding is the shared workspace import inside the external group;
moving it to its required group restores the exact prior passing bytes under inverse-header
verification. Scoped formatter/whitespace checks pass. No assertion or runtime code changes.
Browser setup or selected widget
value alone cannot prove installation; resulting commands and actual applied SDK state need
their corresponding evidence. Recipe Console's distributed Execute UI additionally lacks a
finite executable run override contract. Its authoring/run/restore/export/saved-recipe outcomes
remain required later work, alongside the full Task58 and baseline acceptance gates.

### Task 60: B06 selected capture and actual application preflight

**Current checkpoint:** B06 selection/application and producer/cohort configuration were
published at7c3 with533 affected cases/43 files and passing normal hosted gates. The composed
HTTP, startup-context, emitted-schema, current-main, history-fixture and policy corrections
have independent final SPEC/architecture and scoped prose acceptance and are now published
at a3b1662df/tree92e4313f. A fresh local Native case passes with zero retries and six correlated
applied receipts before Connect completion, with partial coverage. Formation and medium-scale
gates pass on a source-matched tree, but the original Release Gate fails11 WS observer cases
using a stale version2 packet. The current canonical version3 fixture follows11 immediate
admission RED failures with11 GREEN and80 adjacent passes. Independent full-file SPEC/QUALITY
review passes; reviewed publication and fresh hosted acceptance remain the next prerequisites. No runtime,
CRDT, retry, timeout or legacy acceptance change is indicated. Configured-API CRDT admission
remains an unreproduced source concern and the held successor stays excluded. E3 has zero
accepted cohorts. The earlier checkpoints below preserve their exact evidence and limits.

**Earlier checkpoint:** The concrete204-case checkpoint receives one required SPEC finding:
consume all canonical nested capture locations. Actual regression RED exposes an absent
top-level normalization error on valid nested bodies;36 assertions fail/12 pass before
the correction. Product acquisition separately witnesses8 failures/3 passes, then routes
implicit room/people/call/director operations through the existing owned acquisition boundary
with complete scoped options. The combined190-case GREEN, shared-web typing and maintained
1466-file typing pass; root reruns all11 final product cases successfully. Explicit Connect
semantics and incompatible mode-change rejection remain intact. The corrected serialized
browser run then fails, exit1/17.491seconds, at the subsequent black-box topology hydration
helper's implicit session.connect. The existing owned acquisition port corrects that caller
after a real-runtime RED1/4; all66 affected cases and package/maintained typing pass. Root's
next isolated browser passes1/1, exit0/50.020seconds, proving six applied Native/step receipts
and exact initialized scopes with the unchanged matrix oracle and zero retries. Whole-slice
SPEC re-review approves all17 owners and closes the nested capture finding. The next test-only
configuration checkpoint witnesses20 FAIL/22 PASS, including all21 original passing controls,
across six focused suites. Real CLI parsing rejects finite selectors, actual child processes
inherit Native for omitted/Off/Signaling requests, persisted observation has no capture-mode
records, and actual workflow shell steps omit the publish selector or inherit an invalid mode
in all three diagnostic worker cases. Four test owners change; production remains unchanged.
The seven-source merge conflict is repaired, independently approved and published as b030215.
The clean33-owner Native/Manual/Join integration passes its focused static/unit checks and
fresh whole-touched-file SPEC/QUALITY review, committed at bd1a03f77 with its exact reviewed
tree preserved. CLI/workflow/configuration sealing remains required. This is incomplete
E3 prerequisite work; no E3 cohort is accepted.

**Current configuration implementation:** The sole implementation subagent re-witnesses
the20 assertion failures/22 passing cases on published7ada before GREEN. Additional
semantic cases cover actual CLI/environment precedence, retained admission provenance,
immutable run inputs and completed Connect receipt admission. The actual Deno deny-run
probe deliberately fences process effects and exposes Git invocation before invalid
capture selection is admitted; this ordering failure must close without treating it as
infrastructure noise. Full recursive standards closure and fresh independent SPEC/QUALITY
review remain required before this slice is accepted.

The terminal configuration checkpoint passes469 tests across37 suites, native benchmark
and shared-web typing, maintained1475-file typing, Deno entry checks and scoped blocking
gates. Root verifies31 current/deleted paths,28 complete current files,18 actual producer
owner hashes, four frozen original tests and unchanged original index bytes. Independent
review then finds a real admission gap: a new B06 attempt can bypass receipt validation
when its initialized configuration has no matching capture-mode descriptor. The standard
Deno path rejects that omission, but the reusable acceptance service does not. Its
historical-cohort comment is not an archive requirement: archive verification never calls
this function. Acceptance and publication are held until independent semantic RED proves
this missing-declaration case, minimum refusal preserves its raw sample/accounting, affected
controls pass and the finding receives re-review. No legacy-retention exception is authorized.
Full-file quality review also finds a four-positional failure probe in each flattened
workload suite and signaling assertions that pin removed private helper names. Correct
the probes with named inputs and remove those obsolete topology assertions while retaining
the actual failure/effect controls. These are required touched-file closure findings.
Correction round1 witnesses2 semantic failures/14 passing controls through actual
service admission for empty and other-case-only configuration. The minimum refusal and
valid positive fixtures then pass36 focused cases across four files; unchanged architecture
and formation controls pass36 cases across three files. Maintained1476-file typing passes.
Terminal changed-style/preservation verification passes. Fresh SPEC/QUALITY re-review
approves all four complete correction files and the exact applicability of the other27
unchanged paths. Root verifies39 original source/test guards, four original tests,18 B06
owner hashes,82 historical evidence files and both raw indices. The combined affected
validation passes533 tests across43 files, and a fresh Deno CLI check passes.
The configuration source checkpoint is accepted for publication; browser/cohort, hosted
and E3 acceptance remain separate and unproved.
The separate API actor is terminal DONE and fresh SPEC/QUALITY review approves both
complete files. Their frozen hashes match, as does the configuration correction. No
implementer remains active. The next two outcomes are publication/current hosted gates
and a serialized Native browser preflight on the published reviewed source.
Root witnesses its real-runner semantic RED: the expired event and first state snapshot
both retain revision2, so the strict increase assertion fails before later revision3 or
fresh-lease verification can execute. A second2-FAIL/11-PASS RED proves that an advanced
Bob-only or disconnected-Alice snapshot was accepted. The final13 semantic cases and62
focused runner controls pass; the correction preserves one shared original polling bound,
strict increase, membership, lifecycle and Alice-session identity. The complete terminal
handoff is independently approved local evidence; publication and hosted acceptance remain.

Completed receipt decoding must be shared once by formation and baseline acceptance.
The initial proposed shared-test placement conflicts with the unchanged benchmark import
allowlist. Current source inspection corrects the owner to the existing shared-web
connection translation boundary beside its capture policy/error, without a public barrel
export. Remove the private formation decoder and the temporary shared-test copy; use
`ApiJsonValue` directly in the two affected package tests. Preserve grammar, application
policy and basic applied-Native admission with unavailable native readouts. Keep strict
Native acquisition as the separate preflight requirement. The existing architecture guard
must pass unchanged. This correction creates no protocol/archive migration or public API
compatibility decision.

**Status:** Read-only readiness audit confirms that an unchanged published431a77 diagnostic
defaults to Signaling and cannot acquire the missing native lifetime/transport evidence.
The initial and aligned test-only runs both expose17 intended failures/16 passing controls
across33 cases, before any production edit. All15 original cases and the new valid-receipt
control pass. Root reads complete failure output and test deltas and independently verifies
both frozen test hashes and all five unchanged production/support hashes. Six additional
malformed finite-receipt cases fail and one valid applied receipt with unavailable native
readouts passes: the expanded RED has23 intended failures/17 passing controls across40 cases.
All33 earlier cases retain their identities and assertions. Root reads that complete output
and verifies all16 source/test and original evidence hashes before releasing the minimum
two-owner GREEN. The frozen correction passes40 cases and the unchanged maintained-test
gate enforces1465 files with zero first-party errors/debt. Shared-test native compilation
passes. The focused ESNext compiler failure is confined to the third-party Temporal
declaration conflict and remains preserved; the maintained gate excludes third-party
declarations and is not a raw compiler zero-error claim. Fresh independent specification
review approves the exact frozen correction after its48-entry integrity check. Quality
review approves the bounded correction after the import-only closure: independent58-entry
integrity and inverse checks restore the originally reviewed source/test bytes exactly.
No behavioral assertion changed and no artificial layout test was added. No new E3 run
is dispatched. At the last inspected GitHub snapshot,
workflow queries return zero in-progress, queued or waiting B06 runs.

The mode cases execute the actual delivery/formation initial and replacement paths and
observe four missing outbound selections instead of explicit Off/Signaling/Native. Four
initial and ten replacement refusal cases accept absent, unavailable, version-invalid,
identity-invalid or mismatched receipts and enter readiness, rather than returning canonical
unverified failure before those effects. These owned external-result fixtures prove the
request/validation defect, not actual SDK or browser native availability. The aligned fixture
uses the actual non-native scope disposition, not-applicable, while availability stays disabled.
Both original raw failures remain preserved.
The expanded cases cover malformed or missing mandatory scope, availability, coverage,
origin and unavailable-reason fields. Its positive unavailable-native case proves only
basic application admission; it does not satisfy the later native acquisition preflight.

Use only the existing delivery and group-formation driver owners for this correction.
Add canonical optional selection to their configuration, snapshot intent before effects,
forward it at the shared initial/reconnect Connect, and validate its actual returned JSON
before session/readiness work. A private finite decoder beside that Connect is the earned
transport boundary; reject unknown version without casting it into the version1 contract.
Reuse canonical intent resolution, required-application policy and unverified errors.
Do not add another control method, policy table, generic walker, recorder, fixture owner,
CRDT dependency or lifecycle/retry/deadline/workload change. Full touched-file closure and
independent specification/quality review precede acceptance.
The existing61-line initial-pair function also needs touched-file closure. Extract its real
pre-activation pair-readiness operation in the same file, preserving counterpart selection,
parallel waits, captured timing, command identities, activation order and returned results.

The launch audit additionally confirms that autoConnect starts the control WebSocket only:
startup Reset/Configure stores configuration, and connectControl registers that transport.
It does not open an SDK RTC connection before the matrix's Connect. B06's minimum launch
path therefore needs finite process selection forwarded into matrix/delivery configuration;
adding a browser query field is not required for this B06 correction. The broader approved
bootstrap/distributed configuration amendment remains required separately.

**Process selection checkpoint:** The existing live-RTC environment module admits exactly
one raw `RALLAR_BLACK_BOX_RTC_CAPTURE_MODE` through the canonical finite parser. Omission
inherits; explicit Off/Signaling/Native preserve their literals; invalid and blank values
reject before launch. The admitted scalar remains stable after environment mutation.
The original API-origin control passes; witnessed test-only RED has15 failures/two passing
controls, and the frozen minimum GREEN has17 passing cases. The second immutability reads
are reached in GREEN, not an observed RED mutation counterexample. Four affected suites
pass61 cases; maintained test types enforce1465 files with zero first-party errors, and
native shared compilation passes. Root verifies all28 source/guard/artifact hashes.
Fresh independent specification review approves the frozen two-owner admission after its
own28-entry verification and exact inverse reconstruction. Quality finds no Critical or
Important issue and one Minor full-file correction: rename the existing environment/clock
reader from `resolveLiveRtcBrowserAgentAuth` to `readLiveRtcBrowserAgentAuth`, updating its
three same-file calls and preserving the complete body. No other consumer exists; this
harness export is not a public SDK contract. The same implementer completes exactly four
identifier replacements; the full-source inverse restores the reviewed bytes, the test
remains unchanged and all50 historical/correction identities match. Fresh maintained types
enforce1465 first-party files with zero debt/errors, and format/whitespace pass. The original
quality reviewer marks M1 addressed and approves with no new finding. Historical17/61 runtime
results retain their original source attribution; no artificial naming test or runtime rerun.
Matrix composition still omits the scalar: this checkpoint proves admission, not browser
propagation, native acquisition, publication or an accepted performance cohort.

**Measurement boundary:** The existing recorder JSONL reader reads the growing run log,
with64MiB transport and8MiB retained-suffix bounds. Initial-C and replacement readiness
timing already starts before Connect. Reading that log after every Connect would therefore
add repeated-history work inside the unchanged measured interval. Keep actual receipt
validation/retention per connection, and prove native-stream acquisition in a separately
labeled preflight using the existing recorder/projection. Missing or truncated event history
remains explicit partial evidence; it cannot certify an unobserved scope. The concrete
preflight/output binding is now concrete from current-source review. The existing
formation/delivery test owners now expose16 new assertion failures with all40 original
controls passing across56 cases. Root inspects every new test delta and actual failure
message, verifies64 evidence identities, reconstructs both original test files exactly and
confirms eight unchanged production/support guards. Fresh maintained types enforce1465
files with zero debt/errors; format and whitespace pass. These are operation-port tests,
not actual acquired browser evidence. The same implementation subagent is released to
GREEN: retain actual initial/replacement receipts, block preflight presence/readiness until
exact scoped acquisition, and preserve completed evidence plus original cause after failure.
Two additional assertions expose strict-acquisition gaps before source implementation:
unavailable Native incorrectly proceeds to three readiness calls, while a non-Native
capability request incorrectly performs Connect before failing receipt admission.
The current RED is18 assertion failures/40 passing controls across58 cases. Root reads
both full new failure outputs and the complete65-line test delta, verifies13 new
source/artifact identities and confirms the original frozen manifest unchanged before
releasing GREEN. All40 controls, including basic applied-Native/unavailable-native
admission without the strict capability, remain required.
The completed GREEN retains actual admitted connections/proofs in formation, reconnect,
delivery and later failure outputs through the existing formation owner. It adds canonical
control-namespace contracts and a narrow optional acquisition port, without a fake reader
method or mutable evidence collector. Review catches one admission-order regression;
the added59th case witnesses the wrong session error before correction restores receipt
admission first. Final affected validation is121 PASS across five suites; maintained1465-file
types, native shared-test compilation, format and whitespace pass. Root verifies50 current
checkpoint identities plus64 preservation identities, with the original frozen evidence
unchanged. Test changes beyond the frozen RED are three additional cases and four canonical
fixture type annotations; all original oracles are preserved. Independent SPEC confirms the
other required behavior but refuses approval for a synchronous acquisition invocation throw:
the async rejection retains one record/original cause, while the synchronous probe returns
the bare Error and zero records. One added regression witnesses1 FAIL/59 PASS before
placing invocation and await inside the direct owned catch; typed Left folding remains outside.
The correction passes60 focused cases and maintained1465-file typing, format and whitespace.
Root verifies20 correction identities; SPEC re-review verifies48 preservation identities and
approves. Initial QUALITY review identifies one sole-use readiness forwarding method in
the control owner; all five complete owners are otherwise accepted. Consolidating the
unchanged async body into the public method passes101 cases across three affected suites,
including all60 retention cases. Maintained1465-file typing, format and whitespace pass.
Root verifies20 current identities and exact full-source/body preservation; no new behavioral
or source-shape assertion is needed for this mechanical correction. Scoped SPEC preservation
and QUALITY re-review approve, with full five-owner standards closure and no remaining finding.
The next test-only RED uses actual returned captures and initialized rows in the existing
default B06 browser case with explicit Native selection; root witnesses its real failure:
expected3 captures, received0 after the realtime operation returned. The zero-retry command
fails once, exit1/25.524seconds, with fresh local services and no overlapping review/validation.
All8 producer/canonical guards and prepared matrix remain unchanged. The recorder's3 successful
Connect rows show Signaling/product-default, confirming missing selector propagation. Actual
serialized action is `rtc.connect`, not the proposal's human label `Connect`; sessionId and
rtcCapture are top-level actual fields. The mistaken initial artifact filter is corrected while
raw originals remain unchanged. This actual pipeline RED releases concrete acquisition,
matrix wiring and output implementation. Their completed focused GREEN passes204 cases
across five suites, with1465-file maintained typing/zero debt, format and whitespace.
Three further witnessed semantic REDs precede malformed-native-row accounting, explicit
null-source refusal and same-scope disposed-capture corrections. The existing bounded
recorder mechanics are shared rather than duplicated; source provenance remains unknown.
The root then runs actual memory-browser verification with the same isolation and zero
retries. It fails once, exit1/18.042seconds, at room refresh before the third initial Connect.
The recorder contains two successful applied Native/step receipts with observed connection
and scope identities, enabled availability, partial coverage and exact matching initialized
active scopes. Room refresh enters product composition's explicit session.connect with no
capture selection, resolving product-default Signaling and rejecting the owned Native
connection. Raw evidence is retained under
`tmp/perf/b06-native-acquisition/actual-browser-green-20261006T142922854215Z/`.
No tests, builds or reviews overlap the browser interval; services stop and all11 source
hashes remain unchanged. A separate implementation subagent owns the bounded implicit-product
acquisition TDD correction; the concrete11-owner SPEC review proceeds independently.
Actual browser GREEN remains pending. This failure does not identify the original post-ICE
trigger, and the121-case/native-compilation result remains historical.
Fresh concrete SPEC review identifies one nested-disposal consumption gap. The actual
48-case regression additionally proves that normalization of absent direct capture throws
on valid nested rows:36 FAIL/12 PASS/64 existing cases skipped. The correction consumes every
finite direct/native/candidate/service/service.native capture fact, including both service
positions, and rejects any matching disposal regardless of order. Other session/scope and
active facts remain eligible. The product correction independently witnesses8 FAIL/3 PASS
before78 affected cases pass. It preserves complete scoped options and canonical capture
snapshots while room, people, call and director implicit operations acquire the owned graph.
Both corrections pass190 affected cases; shared-web typing, maintained1466-file typing,
format and whitespace pass. Final formatting and a cleanup callback's void-return typing
adjustment follow that combined run; root then reruns all11 final product cases, exit0.
The next actual zero-retry browser run traverses the corrected product room acquisition and
fails at the subsequent `readAndHydrateRoomState` helper's session.connect, still requesting
default Signaling against Native. Exit1/17.491seconds; all source hashes remain unchanged and
services stop. Raw evidence is retained under
`tmp/perf/b06-native-acquisition/actual-browser-corrected-20261006T145452832327Z/`.
The same worker owns the remaining harness acquisition TDD correction; do not weaken explicit
Connect compatibility or change observer/measurement/workload policy to bypass either defect.
That correction is now complete: the narrow room-refresh port invokes the controller's
existing acquireConnection with the full scope/deadline/AbortSignal options. The regression
uses the actual owned Native runtime/controller, witnesses1 FAIL/4 original passing controls,
then passes5/5 and the66-case affected suite. Shared-test compilation, maintained1466-file
typing, formatting and whitespace pass. Root's next serialized browser passes1/1,
exit0/50.020seconds, at
`tmp/perf/b06-native-acquisition/actual-browser-harness-corrected-20261006T150431788589Z/`.
Its original recorder contains six successful applied Native/step receipts with partial
coverage and exactly one matching initialized active scope per Connect. Both realtime and
message trio acquisition-proof assertions execute successfully. The safe projection is
`actual-connect-native-summary.json`; complete original JSONL is retained. The list reporter
does not persist attachment bodies, so do not claim exported attachment contents as evidence.
No validation/review work overlaps measurement; all source hashes are unchanged and owned
services stop. This is local diagnostic verification, not an accepted E3 cohort or resolution
of the historical post-ICE stall. Fresh whole-slice SPEC re-review approves all17 current
owners, independently verifying six exact recorder correlations and preserved controls.
Source-conflict repair is complete and published; clean33-owner integration now receives
SPEC PASS and QUALITY APPROVED, including every full test body. Original runtime evidence
remains scoped to the original source; combined-source browser and E3 acceptance remain required.
The separate local Native preflight acquires initial
scopes; governed/replacement calls retain receipts and omit repeated JSONL reads.
The endpoint can return snapshot fallback with indistinguishable headers, so HTTP200 proves
received endpoint evidence, not durable origin or stream ordering. Recorder rows retain
command-derived attribution and actual results, not the complete authored commands.
Do not add a second observer,
hot-path sink, invented capability claim or changed retry/deadline/workload to bridge it.

- [x] Trace published acquisition, actual evidence consumers and current workflow/source gates.
- [x] Run and independently witness semantic test-only RED with original controls preserved.
- [x] Complete minimum GREEN and affected type/standards checks on the frozen40 cases.
- [x] Verify actual memory-browser selected receipts and native status rows at their exact scopes.
- [x] Repair the actual PR633 source conflict against fetched main while preserving unpublished
      diagnostics/Manual/test work and the independently held CRDT proposal. Current parent
      source identities remain attributable. The eight-owner reconciliation and import-only
      closure receive SPEC/QUALITY approval, and the published repair is MERGEABLE. Native
      runtime verification on the integrated source remains separate.
- [x] Integrate the clean33-owner Native/Manual/Join slice by its real base and complete fresh
      whole-touched-file SPEC/QUALITY review. Commit bd1a03f77 preserves the exact reviewed
      tree, other39 original source/test guards and original index. Current309/50/60/33 focused
      checks and affected static gates pass; this does not certify combined-source browser/E3.
- [ ] Seal observation CLI/workflow/worker/configuration and validated same-mode cohort evidence.
      Test-only RED is witnessed at
      `tmp/perf/b06-configuration-sealing/test-only-red-1791299706231520000/semantic-red.log`:
      20 FAIL/22 PASS across six suites, all21 original controls preserved. This is actual parser,
      child environment, persisted observation and workflow-shell behavior, not a missing export
      or source-text assertion. This frozen RED earned the initial correction; source-conflict
      repair and independent acceptance of the integrated33-owner Native/Manual/Join slice are complete.
      Initial GREEN is terminal; independent review identifies the missing-declaration
      admission gap described above. Its witnessed minimum correction is terminal and receives
      fresh re-review. The clean published source's zero-retry Native browser preflight passes
      one matrix case in50.532 seconds; all six applied receipts correlate to their initialized
      scopes before Connect completion. Fresh required hosted correctness passes at7c3;
      governed producer/cohort acceptance remains outstanding. The current combined affected
      suite passes533 cases across43 files.
      Observation now receives the admitted immutable selection before constructing runtime
      owners. CLI overrides selected environment input and the canonical default; actual
      allowlisted environment facts remain separate. Producer argv and resolved configuration
      share the sealed mode, child inheritance is removed, and reconciliation retains the
      initialized selection. Completed Connect application is checked before successful
      new-attempt publication. The scalar/JSON extension boundaries and closed version1
      requests/archive readers remain intact.
      Current B06 provenance hashes17 exercised producer owners and the actual
      playwright.full-stack.config.ts, including acquisition/recorder/translation policy.
      B05 retains its separate inventory. These18 hashes describe the present workload;
      they do not relabel historical archives or claim full transitive source coverage.
- [ ] Select the reviewed immutable source and run the requested diagnostic/E3 workload with
      original attempt accounting and measurement isolation.
      First close current hosted correctness: the architecture-boundary and bounded API
      summary-convergence corrections are independently reviewed and published, and the actual
      presence-lease recipe and all30 recipes pass on the terminal Postgres shard. The tooling
      failure is the old exact workflow dispatch shape rejecting the approved capture selector;
      static checks additionally require six individual resource/admission classifications.
      Their bounded two-file correction receives SPEC PASS and QUALITY PASS after final
      clarity closure, with production and checker unchanged. That correction is published
      at7c3 and all three fresh hosted workflows pass. The HTTP destination, startup context
      and B06 emitted-schema corrections are now independently accepted locally. The
      fixture/policy closure is independently accepted, and final corrective code SPEC and
      architecture review approve the composed source. Correct-e366 changed-style validation
      passes and all18 structural observations have human dispositions; the original composed
      style failure remains preserved as resolved historical evidence. The sole current-status
      prose finding was accepted and the composed correction published at a3b1662df. Its original
      Release Gate fails11 WS observer tests because a common version2 positive fixture is
      rejected before dispatch by current version3-only ingress. Immediate admission RED11,
      canonical typed-fixture GREEN11 and80 adjacent passes are retained. Independent full test-file
      SPEC/QUALITY review passes; publish that correction and inspect original-attempt hosted acceptance.
      Select the reviewed exact main snapshot required by the governed producer after those gates
      support integration and the repository's explicit main-commit approval is obtained.
      Neither historical nor current failure authorizes a production RTC recovery, retention,
      retry or timeout change.
      The controller runs the3+11 primary; a passing primary triggers the3+22 repeat only
      when its existing repeat requirement selects RTC-B06. Do not add an unconditional
      repeat, retries or replacement samples.

Manual's accepted browser result supports the SDK application capability but does not replace
this B06 path. Held Task58 public typing and the remaining Recipe Console/distributed outcomes
remain independent required goal work. E3 still has zero accepted cohorts; the initial
post-ICE stall remains unresolved.

**Current parent reconciliation:** Main advanced to
94e72f4828e9db5111dc06e4746f1ce09f68ead2 and PR633 acquired two real conflicts.
The earlier exact administrator-merge proposal is stale; no default-branch commit,
push or merge is authorized by that proposal. A feature-only merge preserves current
main semantics and the reviewed capture/acquisition work. Reconciliation retains the
real null-delete HTTP test with independently specified request/response expectations,
and the unchanged251KiB bundle cap. Actual browser entry is256666B Brotli
(250.650390625KiB), leaving358B under that cap.

Fresh SPEC/QUALITY review accepts both conflict owners. The SAME author then records
one exact path/rule/undefined-owner disposition for the test's raw HTTP observations;
the SAME reviewer verifies both captures feed independent assertions, all451 prior
entries/order and matcher/caps are preserved, and unrelated/named owners remain blocking.
This is a reviewed untrusted observation boundary, with no production legacy exception,
new decoder, migration or broad checker suppression. Focused checker suites pass88cases.

The reconciled focused consumer suite passes332cases; shared-web typing and browser
bundle reporting/checks pass. Broader validation passes480 benchmark-package cases,
shared/shared-test typing,1490 maintained test-file typing with zero debt, and the
headless boundary case. Initial game builds stop on a missing local React plugin.
Installing pinned dependencies solely in this repair worktree leaves the lock and
protected original checkout untouched; both canonical game builds then pass. Existing
large-chunk warnings remain disclosed. A concurrent verification wrapper briefly
contends on Git's index lock before starting the Relic build; no source changes result,
and only that unstarted child is subsequently executed. Original failed setup evidence
is retained. Final prospective style passes with no new findings against the actual pre-merge
merge-base d5db1569. Committed current-main style/coupling gates pass at parent979. Fresh Branch, Formation, Medium and CodeQL all succeed with independently verified original artifacts, checkout proofs, published validation and equivalent synthetic merge tree. These parent results are correctness/build evidence; combined continuation acceptance remains separate, with no native cohort acceptance.

Full diagnostics configuration through UI, recipes, workers and Actions remains required.
The separate continuation PR645 publishes bounded source/test slices promptly; its
simulated UI/clipboard proofs do not replace actual SDK/native application/refusal,
fresh external effects, existing reload semantics or B01–B06/E3 acceptance. The confirmed
observer overhead and connection-expiry mechanism remain established; the initial
post-ICE trigger remains unresolved. E3 has zero accepted cohorts, and B07/retry work is
held. No Issues were created or reused.

### Task 61: Executable distributed run capture intent

**Status:** Locally implemented and independently accepted for executable intent.
Separate witnessed REDs established strict schema rejection and command projection loss;
their original assertion bodies and failed logs remain preserved. One canonical optional
root input now reaches every target through the existing ordinary invocation, including
Configure isolation, inline/reference and staged/direct/manual/automatic/scheduled cases.
Accepted snapshot restore and serialized export retain explicit Off and omission.
The reusable shared fixture also passes actual HTTP admission, execution and result/export.

Final native focused tests pass54/0, full controller tests254/0 and shared controls100/0.
Independent SPEC review accepts this exact scope; the first QUALITY review's changed-style
and temporary-storage lifetime findings are closed by scoped fix re-review. Exact reviewed
JSON boundary dispositions preserve guards and matcher policy; affected HTTP tests pass4/0
and policy controls88/0. Maintained test typing enforces1,478 files with zero debt/errors.
The earlier raw vendor-declaration compiler failure remains failed diagnostic evidence,
not a claim that vendor declarations pass. All10 final authored owners and original
RED/report identities are root-verified; the local implementation is not yet published.
Support advertisement and actual applied receipts are not certified by invocation data.
The exact main integration decision remains pending and E3 has zero accepted cohorts.

Add one optional canonical `rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode` input to
the distributed run manifest, its shared builder and strict schema. Omission means Inherit;
explicit Off survives serialization. Every selected target and role receives that input
through the existing `recipe.run.rtcCaptureMode` boundary. Reuse the ordinary invocation's
precedence policy; do not add a per-selection knob, copy the resolver, rewrite recipe
Configure or place executable intent only in metadata or variables.

Witness strict JSON acceptance and command projection independently before production
edits. Execute dispatched load/run commands in the real ordinary runtimes and observe the
owned connection effect port and returned invocation. Preserve all three modes, omission,
invalid-input rejection, Configure isolation, inline and loaded reference-only execution,
staged/direct/manual/automatic/scheduled starts, and accepted manifest restore/export.
Reference-only forwarding does not prove that an ambient loaded body matches staging;
that identity guard remains required downstream work.

Run focused controller decoder/service tests and affected shared manifest/schema/runtime
controls, then shared-test TypeScript and native controller checks. Review and remediate
each changed file in full; modified support files enter closure recursively; independent
untouched code stays outside closure. Preserve the reviewed integration source and held
successor work by executing this slice in its separate feature worktree.

### Task 62: Required capture support admission for every target

**Approved continuation2026-10-07:** After the plain-English API explanation, the human
approves the exact required-input/default-composition/client-clock proposal and restates
“No migration code, no legacy retained, avoid duplication.” The same writer resumes fix
round1. Existing typed construction REDs and all prior source/raw freezes remain the TDD
starting evidence. Change the canonical owners and verified callers directly; the default
factory must own actual composition, with explicit unavailable dependencies preserved by
the required factory. No compatibility overload, alias, legacy forwarding wrapper or
duplicated policy is authorized. Delivery status passes with OPEN_DRAFT/no existing PR
for the continuation; after coherent source and focused GREEN, planned combined affected
checks are released. Full touched/support closure and the original reviewer's single
scoped re-review remain required. This approval is separate from the pending PR633 main
merge and does not supply SDK receipt, downstream configuration or E3 acceptance.

The approved construction correction now reaches its original clock, session, request,
identifier, delay and unavailable-fetch assertions: first focused GREEN37/0. A complete-file
runtime-store witness separately observes malformed recipe JSON throwing an internal
`recipe.commands.map` error (one failure/two controls); the canonical validator correction
then passes with valid-input controls in the affected runs. Intermediate GREEN96/0,377/0
and198/0 retain their actual Node storage warnings. After owned test-environment corrections,
the producer/public-construction run is warning-free GREEN66/0 with warning traces enabled.
SDK fixture consolidation stays in its existing test owner; the untested relocation draft
is preserved only in ignored scratch and removed from source. Those intermediate passes
precede the final checks and source freeze below; they do not accept Task62, downstream
receipt work or E3.

The first combined affected run is retained with six failures/602 passes: five reload
cases fail in test setup because assumed `window.localStorage` is unavailable; the default
browser support witness times out while bootstrap reset lazily imports the page runtime
that its fixture did not install. Controller correctness283/0, maintained typing1,478/zero,
controller/shared-test type checks and the app build pass; the build's chunk-size advisory
remains visible. The corrected owned-storage/actual-SDK-page-runtime fixtures now pass
49 focused tests without warnings. The first changed-style check exits1 with22 findings;
the same writer then closes the actual named-input and known-port typing violations and
assesses untrusted JSON/wire boundaries and navigation before final checks. Review-only
cognitive scores do not require a line-count split or waive a real violation. No timeout
increase, production suppression or manufactured receipt is selected.

The exact redaction-fixture warning is isolated to two response-only fetch fixtures that
omitted their session reader. After explicit owned `readSession`, the final combined run
passes608/0 without warnings, with warning traces enabled. Visitor consolidation shares
active sibling-scope construction across discovery/classification and retains focused91/0;
maintained typing remains1,478/zero and shared-test typing passes. The settled changed-style
result is still exit1 with three specific review signals: runtime-store cohesion50, its
single local JSON parsing `unknown` before canonical validation, and finite visitor
cohesion70/worst parallel20. No new disposition or mechanical split is used. Root verifies
56 complete frozen/current source and preimage identities, unchanged HEAD/index, preserved
original RED declarations and the prior153,634-byte report prefix. The actual fix package
has37 complete-context changed owners and19 frozen unchanged dependencies. The writer now
stops with DONE_WITH_CONCERNS: complete report183,927 bytes, preserved153,634-byte prefix,
and113 actual command/raw pairs. Root reads the entire30,293-byte append and verifies all
source, report, metadata/log and child-exit identities. The single scoped re-review is now
released to the original reviewer, including all original findings and the three actual
nonzero style signals. This is verified source/raw evidence, not Task62 acceptance or live
execution-order telemetry. Task63 remains next after independent Task62 acceptance.

**Completed scoped re-review and fix round2/5:** The original reviewer marks I1–I4/M1/M2
ADDRESSED, with SPEC and QUALITY still NEEDS FIXES. N1 observes a schema-valid, executable-valid
`crdt.open` with an empty name and local-only transport: create returns draft, then stage
throws “CRDT option must be a non-empty string.” The valid-name control returns a visible
failed snapshot because its selected agent is absent. The new collector calls the complete
execution decoder merely to classify transport; unrelated command validation now escapes
admission. The same writer must witness the actual controller boundary RED and preserve
canonical transport precedence and execution validation through a coherent shared policy
or an explicitly contained failure. No duplicated precedence resolver or unrelated schema
tightening is authorized.

Source recovery during fix2 also shows that the connection schema validates capture mode
but permits additional `crdtTransport` values. A transport-only decoder that still throws
on those values would leave the same admission boundary unsafe. Include this schema-valid
path in the semantic witnesses, distinguish invalid/unverified transport from omission or
proved local-only, and preserve strict execution errors and valid top-level overrides.
This is an admission-policy correction in the existing black-box owner, not a CRDT algorithm
change; these source facts alone do not establish its RED or GREEN.

The first focused fix2 controller run typechecks, then reports7 passes/26 failures:
18 blank-name exceptions, six invalid-transport exceptions and two different assertion
failures in valid local-only missing-target controls. Those controls incorrectly expect
an error-bearing failed snapshot at both boundaries; stage fails without that error and
start remains running under existing non-capture semantics. The same writer must correct
the control premises without broadening the identity policy, preserving the first attempt.
Root retains the raw output/metadata and explicitly post-check observed source copies.
The24 exception failures are real boundary evidence; assertions after those exceptions
remain unreached. Corrected RED, GREEN and independent acceptance are still pending.

After preserving that attempt and a second25-failure/eight-control run with an exact
undefined-property assertion mismatch, the corrected focused RED reports24 exceptions
and nine passing controls. Both stage/start paths prove schema/executable validation and
draft creation before the exception. Literal local-only missing-target controls now
preserve the distinct existing stage/start states, links and absent dispatch. Root verifies
all11 retained source/log/metadata identities and the actual child exit1; no assertion
failure remains in the final RED. Later dispatch/refusal assertions still require GREEN.
The writer proceeds with a finite valid/invalid canonical transport policy and strict
execution error translation, then coherent function refactoring. Current source has begun
changing; retrospective artifact verification does not assert live tool ordering.

The first focused N1 GREEN now passes33/0 with the same controller witnesses: dispatch,
capture refusal, missing-target and strict execution controls reach their assertions.
The existing decoder owner has one finite nonthrowing transport resolution policy; execution
translates invalid input to its strict TypeError, while admission consumes transport proof
without decoding unrelated command fields. Root reads the actual command/output and observes
the canonical source, retaining explicitly post-check copies. Coherent N2 refactoring and
final covering validation remain underway; this first GREEN does not accept Task62 or
certify SDK application, storage preservation or E3.

N2 identifies three actual named-function violations under the current greater-than60-line
rule: `visitParallel`91 lines, `bootstrapControlAgent`71 and the deterministic conformance
fixture147. Named fixture builders are governed by this rule; test bodies are exempt.
The fix must expose real discovery/classification, bootstrap lifecycle and command policy
boundaries in place, with meaningful covering tests. No relocation-only split, forwarding
chain, new exception, migration code, retained legacy or duplicated implementation is
authorized. Root reads the complete39,681-byte review, then verifies and freezes60 actual
source preimages plus the183,927-byte report prefix before releasing the same writer.
All earlier failures and freezes remain intact. The original reviewer will perform one
scoped re-review after the completed fix evidence; Task62 is not accepted and Task63,
downstream configuration and E3 remain required.

The first N2 covering run passes116/0 across six actual gate, conformance, CRDT command
boundary and workbench test files. The conformance fixture now separates pure command-result
policies from its single clock/event shell, and bootstrap runtime setup has an owned reset,
Configure and validation lifecycle boundary. Root retains explicitly post-check observations;
the provisional unformatted function audit is not final standards acceptance. Delivery status
passes with OPEN_DRAFT/no continuation PR before planned final validation. Complete formatted
function/separation review, final covering checks, source freeze and the original reviewer's
single scoped re-review remain required. No source publication or main/E3 operation follows
from this checkpoint.

**Completed fix round2; independent re-review running:** The writer stops with
DONE_WITH_CONCERNS. Root reads the full24,552-byte final report append and verifies61
current/frozen/preimage source identities,42 command/raw pairs and114 auxiliary artifacts.
The actual six-owner fix uses preserved working-tree preimages; unchanged HEAD..HEAD is
not a fix diff. No migration bridge, legacy forwarding path, duplicate transport policy,
source relocation or new exception is introduced.

The canonical decoder owner now returns Either for raw transport selection. Admission
consumes that result without validating unrelated execution fields; strict execution
translates failure at its existing command-framework exception boundary. The corrected
35-case controller family covers blank names, invalid configured transport, valid local
and nonlocal precedence, omission, support, visible refusal and actual dispatch. The
intermediate33-case GREEN and all first RED/control-setup failures remain preserved.

Parallel traversal exposes owned branch, discovery and continuation phases; bootstrap
exposes reset/Configure/provider validation and accepted publication before socket intent;
the deterministic fixture uses pure command-result policies behind one clock/event shell.
The final named audit covers95 functions with no greater-than60 violation: parallel21,
bootstrap36 and fixture18 lines. The visitor's remaining50-line function has a recorded
responsibility/separation review, still subject to independent acceptance. Public bootstrap
coverage passes3/0; its first mistaken refusal expectation is retained as a setup failure.

After the Either correction, the actual affected27-file run passes642/0, native controller
318/0, maintained typing1,478/zero, controller/shared-test checking and app build. The last
canonical command-type annotation cleanup has its own conformance4/0 and maintained typing
checks. Exact61-owner formatting and whitespace pass. Changed style exits1 with five
raw-input/JSON-boundary and warn-tier cognitive diagnostics; structure reports seven
observations, and the build chunk advisory remains. The required overall style report exits0
with3,450 nonblocking findings; that does not waive touched-file violations. The one scoped
re-review is released to the same original reviewer. N1/N2, Task62 acceptance, downstream
SDK receipt/body/replay/UI/recipes/Actions outcomes and E3 remain incomplete until their
own evidence and verdicts. No source staging, commit, publication, main or E3 operation
is performed by this checkpoint. No Issues are created or reused.

**Independent fix2 acceptance:** The original reviewer marks N1/N2 ADDRESSED,
SPEC and QUALITY PASS, with no new Critical/Important/Minor breakage or out-of-scope finding.
It independently verifies all61 source identities,42 raw/metadata pairs and114 auxiliary
artifacts; reconstructed source confirms95 named functions/none above60. The five changed-style
diagnostics are assessed as explicit raw JSON/transport input normalization and coherent
warning-tier owners; the tool's exit1 and bundle advisory remain preserved. Root reads the
entire34,845-byte report, verifies its SHA and unchanged accepted source. Original
I1–I4/M1/M2 were already addressed; no Task62 finding remains open. Task62 is locally accepted,
with no source staging, commit or publication. This supplies installed-support/admission
acceptance, not SDK application/storage, body/replay, UI/recipes/Actions or E3 acceptance.
Task63 is the next test-first slice; no Issues were created or reused.

**Verified evidence before the approved I3 continuation:** Named-target and serialized blocker corrections have focused
GREEN15/0; capability/producer corrections have GREEN60/0, and affected schema/target
controls pass104/0. These recorded passes precede additional witnesses and are not final
slice acceptance. The current construction witnesses have three checked failures/34
passing controls, with maintained typing1,478 files/zero debt/errors. Their failure sites
prove the ignored clock, ignored session dependency and ambient fetch fallback; later
assertions after the first failures remain unobserved. Root verifies11 source snapshots,
five command/log pairs and the three unchanged held construction owners. The public input
decision was pending at this checkpoint and is now approved as stated above. A storage warning in this new factory test seat is preserved
separately from the earlier warning-free60-test run.

A controlled additional I2 RED observes an actual delayed CRDT command consuming a
parallel sibling's WS Configure with Native capture intent, while admission still selects
an unsupported target: one failure/42 passing controls, maintained typing1,478/zero.
The witness asserts the exact deliberate feature-port refusal before SDK execution and
then compares the observed input with admission; it supplies no applied receipt or
network success. Runtime configuration is shared while capture selection forks per branch;
the collector's authored-order traversal misses that possible interleaving. The analogous
structured WS witness now reaches its owned route with the literal Native context and
then demonstrates the same unsafe admission. Their combined RED has two failures/42
passing controls; six further controls pass for concurrency one, explicit local-only,
Health, omission, local-only Configure and an explicit Configure reset. Root verifies the
final two-failure/48-control output and freezes11 source/raw artifacts. Root now also verifies
maintained typing1,478/zero for those final RED controls and the first focused GREEN50/0.
The existing visitor records finite Configure alternatives and reuses the actual decoder,
route predicate and branch capture owner. Root verifies its eight raw/source inventory
identities and observes the working owner. The fix-introduced false refusal is now confirmed:
one branch replaces its own WS Configure with local-only before opening, while the other
branch contains only Health. The exact owned input is local-only with Native intent, yet
admission refuses it. Corrected RED has one failure/52 controls and maintained typing1,478/zero;
root verifies12 inventory items plus two original source copies. The initial two-record
Health fixture failure and the earlier WS callback-narrowing compiler failure remain
separate failed evidence. The writer is released to distinguish actual sibling Configure
possibilities from a branch's own superseded values, with a post-parallel sole-writer reset
control required too. The revised configuration traversal now passes71 focused gate/target
tests and maintained typing1,478/zero, including the exact sole-writer input and nested
inside/post-block reset and sibling controls. Root reads the complete final visitor and
report append, verifies14 source/raw inventory items and both retained report prefixes.
An earlier misspelled target path selected only53 gate tests; its exit0 does not prove
target coverage. The corrected command explicitly selects both actual owners.

The further reference classification gap now has a controlled semantic RED: after loading
a Health recipe, a parallel branch waits before a body-less
`recipe.run`, while a sibling loads an RTC body. Runtime freezes the loaded body when
that nested run is admitted after the wait; the collector still classifies the original
Health body and admits an unsupported agent. Corrected RED has one failure/55 controls and
maintained typing1,478/zero. The actual absence wait and exact Connect-input refusal with
Native context are asserted before the admission failure. Root verifies14 source/raw
identities; initial child-ID lookup and missing-method fixture errors remain separate.

A boolean unknown-reference shortcut would miss an authored loaded recipe's Native mode
under omitted ambient intent and could falsely refuse distinct known Health-only bodies.
The additional owned-input body-Native witness confirms that gap: two checked semantic
failures/60 passing controls and maintained typing1,478/zero. Five literal controls retain
known Health, inline bodies, genuine omission, serial execution and explicit loaded-body
reset. Root reads both exact Connect observations and verifies six source/raw identities,
plus the new report's unchanged136,563-byte prefix.

The finite declared `recipe.load` bodies must use the existing visitor/canonical capture
policy. Source recovery confirms that ambient references can recurse despite finite JSON;
neither inline validation nor runtime lifecycle depth supplies a mandatory reference bound.
The approved internal design distinguishes active known body, canonical capture selection
and finite configuration-origin/loaded-body facts, skipping only identical active states.
Merge-to-authored-input provenance remains local to collection; no hash or credential
serialization is selected. The recursive controls now have checked RED: eight failures/60
passing controls, maintained typing1,478/zero. Two failures are the observed loaded-body
admission gaps; six are resolver stack overflows before their later mode/admission assertions.
Literal validated bodies cover Health-only admission, RTC before reentry, changed route/mode,
Native-only refusal and Off-plus-Native acceptance. Root verifies10 RED source/raw identities.
The same writer's finite known-body traversal and identical active-frame guard now have
focused GREEN91/0 and maintained typing1,478/zero, with the exact two-owner format command
passing. Root reads the saved raw outputs, complete visitor, canonical capture sequence,
actual Connect-input witnesses and literal recursive/lifetime controls. The six recursive
cases now reach their later mode/admission assertions. Additional controls preserve possible
final loaded bodies, serial certainty, own resets and changed loaded-body modes. The settled
source checkpoint is now frozen: root verifies35 complete source/preimage copies,67 raw
command/log pairs, unchanged HEAD/index and all three held construction owners. Root reads
the complete11,846-byte report append and verifies its unchanged141,788-byte previous prefix.
The settled-source check again passes91/0, maintained typing1,478/zero and exact two-owner
format checking. This is retrospective source/raw-output correlation, not audited live
tool-event ordering, SDK application or final Task62 acceptance. The writer stopped
independent work at this checkpoint and now resumes the approved construction correction; broad final validation and
scoped re-review remain required.
This is admission traversal
termination, not runtime rejection, a runtime depth limit or a liveness proof. Unknown or
unavailable references retain their existing conservative boundary. No arbitrary external-
body analyzer, replay guard or runtime change is selected.
The writer must settle required support classification before I2 acceptance. No runtime
parallel, CRDT synchronization, timer or retry algorithm change is selected. Broad final
validation and the original reviewer's scoped re-review remain open; Task63 is not released.

**Status:** Three typechecked semantic REDs are independently witnessed and frozen:
shared resolution selects a target with no capture advertisement; explicit two-role
staging queues both loads; unstaged manual start queues both Native runs without refusal.
Native tests retain32 passing controls and shared tests9; maintained typing passes with
zero debt/errors. At the frozen RED checkpoint, only the two released test owners changed;
17 frozen owners, all prior service content, HEAD and the empty index remained unchanged.
The sole writer has completed GREEN and frozen source for review. Root separately verifies three producer
semantic failures with20 passing controls and one typechecked actual HTTP stage refusal
failure with4 passing controls. Their original source, logs and actual child exits are
preserved. The producer's initial setup type error remains separate failed evidence;
the corrected maintained gate passes1,478 files with zero errors. No final source acceptance,
deployed support or application is claimed yet.

Two further semantic witnesses expose restaging replacing original membership and caller
options swapping the executor after its support is captured. Root verifies both failed
child exits, the preserved witness calls and the same focused assertions passing1/0 each.
Restaging's full pre-correction controller was not snapshotted; its explicitly labelled
reconstruction is diagnostic only. Root verifies recorded full controller correctness268/0,
affected shared/browser/app controls201/0, maintained typing1,478 files/zero debt/errors and
application build exit0. Changed-file style passes without new findings; structure passes
with four navigation observations. One Node storage warning and the build's bundle warning
remain visible. Root verifies all30 first-review checkpoint SHA/blob/preimages,21 changed final-source copies,
42 raw-command identities, the original RED report prefix and three original witness hashes.
The completed report preserves its original writer bytes and a labelled controller chronology
correction: root's additional REST witness verification was retrospective, not a live
pre-implementation approval. Independent SPEC/QUALITY review returns issues found/needs fixes.
One in-memory controller witness stages only the supported surviving peer when another
explicitly named peer is absent under selected-agents/ordered-targets. A second witness
shows command-owned `rallar.crdtTransport: ws` decoded as live WS execution while capture
requirements are empty. Both focused checks exit0 and demonstrate policy failures; they
are not passing acceptance tests. The complete review also requires explicit runtime/client
dependencies and removal of duplicated heartbeat coverage. The same writer receives these
four findings together, with semantic TDD for behavioral corrections and scoped re-review.
Absent/unverified producer assertions must reject every unsupported advertisement, and
the Node storage warning remains a named test-environment finding. The build chunk advisory
is retained. No new public compatibility exception, migration or CRDT algorithm change is
approved. Acceptance and publication remain open.

Before the2026-10-07 approval, fix round1 recovers a genuine public construction decision: `mod.ts` exports the browser
factory/options and control client/options, and the browser agent, Console and18 test
owners use their current partial inputs. A concrete proposal requires explicit browser
dependencies, adds a named default-composition factory, injects the client clock and
removes the browser cleanup input that execution never honors and no recovered caller
supplies. Wire/persistence behavior is unchanged by the proposed source contract. Root
reads and verifies the complete proposal and both production construction sites; human
approval was pending at that checkpoint, then granted as recorded above. No wrapper, alias, migration or
retention exception is authorized. Independent admission TDD continues meanwhile.

Root verifies fix1's actual checked native RED:12 failing selected/role-map stage/start
cases across absent, unidentified and offline peers, with the unrelated missing Health-role
control passing. The corrected shared RED has2 transport-override failures and54 passing
controls; maintained typing passes1,478 enforced files/zero errors. The earlier new test
typing error remains preserved as a failed setup/static gate. All30 reviewed preimages,
three checked RED source snapshots and15 raw log/command artifacts match their frozen
identities; at root's observation, all24 production/support owners remain unchanged.
The Node warning trace identifies auth-session-presence access during browser-agent startup;
the separate recipe/messaging controls pass64 without that warning. Test-environment
correction and GREEN remain open. A strict unidentified capture-blocker decoder/restore/export
witness now has checked RED:1 decoder failure and7 passing controls, including strict
malformed/other-status identity refusal. Its original compiler-only six-error attempt and
exact corrected witness source remain preserved. RED stops at the decoder's mandatory
identity rule; the later real disk-restore and export assertions require GREEN evidence.
The same-slice union correction must not fabricate identity or loosen unrelated blocker
shapes. These artifact checks do not claim live preflight-order telemetry.

I2 recovery also confirms a recipe boundary mismatch: the browser feature executor merges
command-owned CRDT connection fields and applies canonical step capture selection, while
the reviewed strict `crdt.open` schema/field list has no `rallar` field and the collector
ignores that step selection. Direct-executor support is not supported serialized recipe
admission. Separate serialized-schema and step-selection REDs are required before those
corrections, reusing `BlackBoxRallarCrdtConnectionInput` and the existing capture resolver.
Close their actual command/schema/snapshot consumers; preserve run/Configure/step precedence,
omission and explicit local-only controls. This is recipe input/admission work, with no
CRDT synchronization algorithm or migration change. Construction input approval was
pending separately at that checkpoint; it is now granted as recorded above.

Focused fix1 GREEN is now verified from actual command/output: checked Deno15/0 includes
all12 named-target stage/start refusals, the unrelated Health control, real disk restore/export
of the unidentified blocker and strict identity controls. Vitest's two complete affected
capability/producer owners pass60/0 with warning tracing enabled and no storage warning.
Root reads the separate I2 schema/step RED2/32 and later mutation/validation RED4/32 plus
their maintained typing1,478/zero;10 raw command/output artifacts and12 separate source
snapshots are preserved with hashes. These focused results do not accept the complete slice:
the held construction contract, broad final gates and scoped independent re-review remain
open. No new source publication, main operation or E3 run follows from these checks.

At the RED checkpoint, the browser agent selects its actual runtime at construction while
identity reporting derives capabilities from mutable configuration. Advertise immutable support
from the installed runtime owner, including injected/custom and absent-runtime boundaries.
A configured provider name or neighboring CRDT capability cannot certify capture support.
Recheck every frozen target before dispatch, including after staging and during automatic
or scheduled advancement; do not re-resolve membership to conceal an unsupported target.

Add finite capture support/version advertisement and reuse the existing target/start
admission owners to refuse required capture work for every unsupported or missing target,
including explicit/resolved targeting, all roles and unstaged manual start. Prove a visible
refusal and no relevant command dispatch at that owned boundary. Preserve omission and
non-RTC controls, including existing explicit-target behavior without blanket identity
requirements. Validate affected capability/resolver/controller semantics and package/app
typing. Advertised support cannot certify a particular connection's applied configuration.

Actual applied-receipt preservation and assessment through compaction/restore/export,
staged/reference-body guards, fresh replay attribution, visible Console/local controls and
saved/imported/rerun intent, generated manifests, hosted/external/mixed/no-spawn and Actions
forwarding remain mandatory later outcomes. No worker lifecycle action satisfies no-spawn
selection. The standalone lifecycle workflow keeps25 manual inputs. B01–B06, governed E3,
the unresolved initial stall and held B07 retain their existing acceptance conditions.

### Remaining capture controls: current source coverage

A completed source-only audit observes91 local source identities at2026-10-07T11:32:32Z.
Root reads its complete40,872-byte report, verifies every current identity and freezes the
observed sources. None overlaps the17 terminal Task63 changed owners; runtime-store is an
accepted Task62 entry boundary. This prepares mandatory later outcomes, without adding a
third concrete implementation slice, choosing a new API or proving deployed behavior.

- **Canonical intent exists:** the shared parser preserves explicit Off and owns run >
  step > recipe > host > product-default precedence. Recipe, run and distributed manifest
  schemas already admit the finite mode. The shared manifest builder projects a defined
  run override. A health-only capture fixture verifies fields, not RTC application.
- **Manual is a separate accepted capability:** its visible desired/current controls,
  direct Connect/Join command construction and draft persistence use canonical mode data.
  Existing full-stack browser cases assert applied state, immutable recordings, reload and
  reset. Earlier local acceptance remains valid at its recorded scope; this read-only
  audit did not rerun those tests or replace Task63 receipt acceptance.
- **Console creation drops the input:** `recipe-console/execute/execute-manifest.ts` and
  `use-execute-workflow.ts` supply no mode to the capable shared builder. The visible
  workspace has no run selector; personal preferences admit six other defaults but no
  capture preference. Stored-manifest projection retains an already-authored field, which
  does not satisfy visible new-run selection. Local JSON/fixture Load/Run and catalog launch
  have no run override control. Saved custom-body import/export coverage remains to be
  established at actual owners; this finite audit claims no whole-repository absence.
- **General recipes and generated manifests need consumer propagation:** reusable live
  recipe options, catalog and world-fleet generator inputs omit capture selection, while
  checked-in RTC bodies omit the root mode and therefore request inheritance. Existing
  source/effective fingerprints and scoped materialization must preserve authored fields,
  explicit Off and complete bodies through save/decode/load/create, rather than certify
  application from a hash or declared support.
- **General worker startup has a missing chain:** worker configuration does not consume
  the capture environment key or emit a capture query; shared launch allowlist/decoder,
  bootstrap and remote Configure projection likewise omit it. Hosted finite environment
  generation omits the key. Exercise real env/query precedence and command composition;
  an invalid nonempty higher-priority input must not silently fall back to a valid lower
  input. Keep the host default distinct from a later run selection.
- **Distributed Actions and operators omit run selection:** the manual wrapper, reusable
  runner, GitHub-free workflow, dispatch helper, materializer arguments and controller
  request path offer no override. Whole-manifest spread can preserve already-authored
  intent but does not supply the missing user input. Existing exact helper-argument tests
  are verified consumer expectations to update semantically, not retention requirements.
  Spawned, external and mixed legs need their real forwarding witnesses. Pre-existing
  external agents must receive the admitted run command and return fresh applied evidence;
  restarting or reinstalling them does not prove this path.
- **No-spawn remains a distinct operator boundary:** its runner forwards an authored
  manifest but consumes no capture selection option; a generically parsed unknown option
  can be silently unused. Exercise strict admission and request forwarding with no worker
  lifecycle or launch-URL rewrite. Keep the lifecycle workflow's existing25 manual inputs;
  neither a26th input nor deleting an existing input is authorized.
- **B06 already has a separate implemented path:** its workflow choice, admitted CLI/env
  resolution, frozen producer configuration, actual child environment, Playwright entry and
  connection command carry mode. This does not repair general worker/distributed Actions
  omissions and does not certify a cohort. Preserve the current governed B06 mode/default,
  homogeneous actual application, exact-main preflight, sampling and repeat conditions.

Later semantic witnesses must cross real UI/CLI/env/query, saved/imported/generated recipe,
materialization, request and SDK boundaries. Preserve omission/inheritance and explicit
Off/Signaling/Native, distinguish desired/requested/installed/applied state, and prove that
editing a desired choice does not mutate an accepted run. The audit inventories focused
unit/process/browser candidates only: all are NOT RUN by that actor. Reuse canonical parser,
precedence, body, fingerprint, bootstrap and request owners; add no migration reader,
retained predecessor or duplicate policy. B01–B06/E3 and the original diagnosis remain
required. No Issues were created or reused.

### Task 63: Finite applied receipt preservation and required-result admission

**Status:** Task62 is locally accepted after independent fix2 SPEC/QUALITY PASS.
Task63 semantic RED is complete and root-correlated; the same implementer has completed
GREEN; the first independent SPEC/QUALITY review returns Needs fixes with two Important attribution findings. The original implementer completed both corrections with semantic TDD; the original reviewer approves SPEC and QUALITY with both findings addressed and none remaining. Actual SDK receipt loss and invalid completion mutations justify this correction.
The earlier nine-source refresh established the owner paths; the existing private SDK fixture
uses the approved canonical default factory. The same SDK-produced Off receipt now survives
actual native disk persistence, recording, restore, fallback and distributed export.
Additional admission, Native-partial and boundedness controls have focused passing evidence.
Complete affected validation, standards closure and fresh independent review are required.
Task63 local acceptance is recorded below; no publication, main or E3 acceptance is claimed.

The first actual SDK Off receipt-loss witness is now observed: the queued ordinary recipe
returns a successful Connect child with applied Off, version1 and a nonempty observed
connection identity, accepted by the canonical application policy. No signaling event rows
are needed. Its body/invocation identity and exact result survive serialized control parsing;
controller admission accepts the envelope, but stored connection evidence decodes as absent.
The focused Vitest child exits1 at that final semantic receipt comparison. The first attempt
failed earlier because the existing loop/parallel reader does not enumerate direct recipe
children; that setup failure is preserved separately. Root reads the exact raw/source/
metadata artifacts and confirms production unchanged from the72-source preimage witness.
Missing/malformed required-success and outer-attribution REDs remain underway; no GREEN,
finite stored contract, restore/export, real disk I/O, live connectivity or E3 acceptance
is established by this first test.

The separate checked Deno controller file now records11 semantic refusal failures/five
passing controls. Public serialized results with missing result/receipt, malformed or
unavailable application, wrong mode, conflicting inner completion, wrong root/child/agent,
wrong invocation selection or connection name are still accepted. Each test addresses an
actual registered and queued required-Off command. The first failure is accepted:true where
false is independently required; later unchanged-results/completion assertions remain
unreached. Literal omitted-intent and valid applied-Off controls pass, together with actual
failure/replay/cancellation controls. Root reads the full frozen test source and actual
raw/metadata. These are controlled serialized admission witnesses; they do not manufacture
SDK application. Production is still unchanged, and final RED evidence/typing/source
inventory is being completed before the GREEN release.

The completed RED phase now confirms the same SDK receipt loss in the full fixture
(48 controls pass), using the correct signaling event topic for the zero-event assertion.
The final controller tests compare admission, stored-result count, completion timestamp and
completed-command IDs together: all11 invalid completions still mutate success state.
Five ordinary/valid/failure/replay/cancellation controls pass. Maintained test typing and
formatting pass. Earlier setup failures remain preserved and distinct. Production is unchanged.
Root verified the completed source/raw evidence and releases the same implementer for the
canonical test-first correction, including actual restore/disk/export/distributed validation.
No migration code, retained affected legacy, duplicate parser, new collector or raised
retention limit is authorized. This release is not GREEN, review acceptance or E3 evidence.

A bounded source supplement identifies an unrun witness in the existing SDK-backed recipe
test: actual returned Connect receipt through serialized control parsing, controller
compaction/storage, JSON snapshot decode/restore and artifact export. Reuse the existing
private fixture and production seams without new exports or a collector. Actual Deno disk
persistence has its separate owned harness; this source preparation does not prove that the
same SDK-produced receipt traverses real filesystem I/O. Refresh against accepted Task62
and witness RED before choosing the finite stored representation.

Use the existing owned SDK Connect completion, canonical application policy and ordinary
recipe invocation. Preserve the finite receipt and its original command, connection and
scope identity with the enclosing run, agent, phase, accepted body and invocation attribution.
The existing pure `toRtcCaptureReadout` and `toRtcCaptureConfiguration` decoder in
`packages/shared-web/browser/connection/to-rtc-capture-readout.ts`, together with
`resolveRequiredRtcCaptureFailure`, already serves B06 acceptance. Reuse these canonical
owners after the outer JSON boundary is validated; do not copy a receipt parser or import
the private benchmark package into product code. Their source is verified at accepted9d;
the new enclosing run/command attribution still needs its own finite validation.
The existing runtime body acceptance ID is not a content hash. Compatible same-mode reuse
keeps its original construction origin; do not require the later desired origin to match it.
Off has a minimal applied receipt. Native application and partial native coverage are
separate facts; neither absence of events nor support advertisement proves application.

Witness actual SDK-backed receipt loss through ordinary serialized completion before
production edits. Separately witness malformed or missing required application, inconsistent
outer/inner completion and attribution mismatches being accepted as success. Serialized
fixtures prove decoder/admission behavior; they cannot substitute for the SDK producer
witness. Preserve ordinary failures, cancellation and unavailable dispositions honestly.

Validate required results before completion state is mutated. Retain bounded typed evidence
through existing compaction, persistence, restore, snapshot and distributed export owners.
Round-trip actual stored results and check disk JSONL, snapshot fallback and distributed
bundles according to their different paths. Replace incidental assertions that every
successful child result must be absent with boundedness and necessary-evidence assertions.
Keep existing evidence limits; no generic recursive walker, duplicate recorder, new collector,
budget increase or receipt-less success fallback is selected.

Retain original body/invocation/receipt and explicit replay disposition when cached results
are transported. Repeated child command IDs must retain their owned loop/parallel path.
Preservation does not certify a fresh execution, staged content hash or new connection.
The later actual staged/reference-body and fresh-scope guards remain required.

Run focused SDK-backed recipe application, serialized control admission, compaction,
snapshot persistence and artifact tests, plus affected maintained typing. Include public
API and browser-boundary checks if entry points change. Apply full touched-file standards
closure and fresh independent SPEC/QUALITY review. Do not migrate historical data or
silently certify unsupported persisted shapes; any verified compatibility requirement
requires the repository's explicit maintainer decision before retaining a boundary.

The first corrected admission run passes all16 cases, and the original SDK application
fixture passes all49 with its receipt comparison unchanged. The intervening compiler
failure is retained. These are provisional runtime observations: early GREEN metadata
mistakenly copied production preimages rather than tested owners. Those records remain
unchanged and are explicitly limited; subsequent necessary checks will capture actual
current source. Additional semantic controls cover valid capture with an unrelated permitted
child failure and controller-known loaded-body references. Unknown reference bodies require
the later binding prerequisite and cannot receive a receipt-less success fallback. Loop/path,
Native-partial, replay, real disk, restore/export and complete standards closure remain open.

The next correctly captured checks witness and close additional semantic gaps: actual
SDK document identity was lost, a corrupted stored required receipt was accepted by restore,
and legitimate continue-on-failure/known loaded-reference completions were refused. Original
failures and compiler setup failures remain retained. Checked controller coverage now passes18
cases. The focused SDK witness passes receipt/observed identity comparison through JSON
snapshot decode, actual in-memory restore and artifact export. These later checks capture13
actual owner paths rather than preimages. Controlled native executor receipts remain distinct
from SDK-produced evidence. Those checks do not establish real filesystem I/O or distributed
export; the later same-producer disk witness below addresses those paths separately.

The actual SDK loop/parallel witness then exposes repeated path rebasing after restore:
the loop's enclosing command path is added repeatedly, and parallel paths suffer the same
corruption. Preserve that semantic RED and its corrected GREEN; earlier capability/snapshot
setup failures remain distinct. All four canonical paths, source paths, positions and child
command identities compare correctly after the correction. A subsequent SDK producer run
and checked native consumer each pass one focused test, binding75 actual owner snapshots.
The native consumer verifies the SDK producer source hash, uses real snapshot write/read/
restore and recorder append/open, then exercises snapshot fallback and distributed export.
Root reads both frozen harnesses, verifies the raw/source and five artifact identities,
recomputes the original serialized envelope hash, and compares the same receipt, invocation,
replay disposition and every original child position field across all five retained forms.
Compaction adds explicit child kind/parent-path fields; those are verified against their
owned positions rather than requiring raw wrapper shapes to remain identical. This is
actual same-SDK Off disk lineage with fake HTTP/WS transport, not live connectivity,
Native completeness, fresh execution, staged content binding or E3 evidence. Final standards
closure and independent acceptance remain open. No migration reader, retained predecessor, duplicate collector or raised
retention budget is introduced by this proof.

Further semantic REDs expose wrong outer run/replay acceptance, corrupt stored restore,
malformed wire lifecycle/error and composite parent/path/source/command/group attribution.
Their corrected checked controller file passes29 cases, including original same-mode origin,
Native partial and an ordinary2,000-child workload whose retained evidence must report its
limit. These application controls use literal serialized receipts; they do not establish
SDK Native capture. The canonical expansion budget stays unchanged and arbitrary child
payloads are omitted. Broader affected checks expose two obsolete topology assertions:
one expects a missing child list where the finite representation now contains an explicit
empty list, and another accepts the predecessor `resultsOmitted` marker. Preserve those
failed checks and replace the assertions with current bounded evidence/failure-count
requirements. Freeze the additional composite-results test owner before its closure;
root verifies its actual preimage against HEAD. Complete affected gates and fresh review
remain pending, rather than treating these focused passes as full acceptance.

Additional checked RED/GREEN covers nested recipe selection, restored queue ownership,
silent sibling omission at the traversal budget, and lost parallel completion/timing
summary fields. The focused native checks pass63 cases with the separately exercised SDK
handoff test explicitly ignored; the covering Vitest run passes102 cases across five
matched owners. Maintained typing and shared-test typing pass after closing the new
recipe-child projection in the existing distributed observation consumer. These checks
do not finish standards closure or independent acceptance.

Restore validation also exposes a real lifecycle distinction: independent command/result
bounds can legitimately retain an old result after its queued command is trimmed. An actual
Configure enqueue/dispatch/accepted completion with runtime retention commands0/results1 fails the
overbroad restore refusal. Preserve that RED and correct the earlier premise that restoring
a historical fact performs new required-success admission. Use the absent retained owner
as the provenance input to one canonical current snapshot policy, deriving unavailable
ownership for historical facts, including outer-only completions. Carry a finite output
disposition where needed for artifacts and current admission; do not require an old stored
record to contain a new marker. Owned required results remain strict, and an unavailable
historical fact must not complete a current queued required command or certify fresh
execution. Unknown reference bodies still have no receipt-less fallback. Witness those
semantics before GREEN. This avoids a persisted compatibility break, migration reader,
parallel store or retention-budget increase; it is not a legacy-retention exception.

The completed read-only source audit identifies the next body/freshness boundaries.
Reference-only distributed staging ACKs a Health command; start executes the body loaded
at runtime admission without an expected accepted-body identity. The existing body token
names acceptance rather than hashing content. The control client can reuse an interactive
runtime under a changed run/agent and emits its cached results with the current outer address;
bootstrap reset and legitimate same-run replay remain separate controls. Reload segment
construction omits root run/recipe capture fields, while independently configured children
may still select a mode. These are source-derived semantic test candidates, not executed
application failures or a diagnosed cause of the original ICE stall. Recheck overlapping
Task63 owners after independent acceptance before the next RED. No migration, dual reader,
retained predecessor or speculative public contract is selected by this preparation.

The current bounded-history controls now cover pending and completed required commands,
including historical failed results. An invalid-status setup failure is preserved separately;
the corrected failed-result witness exposes acceptance of unavailable ownership before the
ordinary-failure early return. The minimum canonical correction refuses unavailable history
before that return. Genuine current failures, cancellation and permitted child failures remain
admissible. Independent runtime retention commands0/results1 restores ordinary and outer-only
historical facts with explicitly unavailable ownership; those facts cannot complete a current
required command. No old stored marker, migration reader or additional store is required.

The covering native run then exposes15 coupled intent-only test expectations: their simulated
executor propagates selection but produces no applied receipt, while their controller assertion
claims success. Preserve the actual intent assertions and require honest refusal with unchanged
completion/storage. References preloaded only in the runtime do not establish controller-known
body ownership. After correcting those expectations and their touched-file closure, the same
six native owners pass164 cases with one optional SDK handoff ignored; that handoff is executed
separately. Five shared/browser/artifact owners pass102 cases. Maintained typing covers1,478
files with zero errors, and shared-test TS/native plus controller main/test checks pass.

Fresh same-SDK producer/native-consumer checks each pass once after those refinements and bind77
actual source snapshots. Root independently verifies source and serialized-envelope hashes,
then compares all four original connection receipts, invocation, command/position/scope identity
and replay across the producer snapshot, actual disk snapshot, disk JSONL, snapshot fallback and
distributed export. This remains Off capture under fake HTTP/WS, with no Native completeness,
fresh execution or E3 claim. Overall style exits0 with3,441 nonblocking observations; changed-style
exits1 with13 findings against clean9d, a mixed Task61/62/63 comparison requiring scoped current
standard assessment. Structure exits0 with seven observations and controller navigation finds
none. Final packet preparation finds that the edited canonical state-construction owner was
omitted from those77 captured paths and its claimed prior freeze was incorrect. Preserve all
attempts and their actual coverage; recover the baseline evidence and add a minimal final
source-bound check with that owner included. Checker tolerance does not waive touched-file closure. Final frozen handoff and fresh
independent SPEC/QUALITY review remain required; Task63 is not yet accepted or published.

The writer's terminal handoff freezes17 changed owners and78 current source identities.
Root verifies every current/frozen source,106 original command metadata/raw attempts with
6,410 captured source copies,35 auxiliary objects, and the complete176,610-byte report.
The original RED prefix and HEAD9d/empty index remain unchanged. The state-only baseline is
explicitly reconstructed and unverified; the added78-owner lifecycle check passes1/0, and
earlier77-bound attempts retain their original limitation. A512,369-byte full-context review
packet uses actual accepted Task61/62 preimages for the other owners and labels that state
reconstruction. The fresh reviewer checks specification, current full-file standards,
legacy/duplication removal and these evidence limits. No acceptance, source publication,
main operation or E3 measurement follows merely from the terminal handoff.

**Independent review round1: two fixes required.** Root reads the complete18,179-byte
review report and verifies its identity, the exact3,001-byte focused harness and complete
raw output, all78 current owners, and unchanged HEAD/index. The diagnostic harness exits0
while observing defects; this is not a passing regression verdict. Its runtime-generated
count-2 loop is admitted normally and remains admitted after iteration2 is replaced with a
second copy of iteration1. Both wrappers are individually consistent, but the duplicated
owned position cannot certify another invocation. A runtime-generated inline outer recipe
with an authored inner `recipe.load` followed by reference `recipe.run` succeeds with an
applied-Off input fixture, yet admission refuses its nested connection because requirement
discovery and result attribution disagree about that known body. This fixture is not
additional SDK construction proof.

SPEC and QUALITY both return Needs fixes:2 Important,0 Critical,0 Minor. The review asserts
no additional concrete current touched-file standards defect; broad checker observations
and the unverified state preimage remain explicit limits. Root releases both findings to
the original implementer together for semantic RED/GREEN and proportional affected checks.
Reject contradictory duplicate positions while preserving legitimate partial/cancelled
results; recover nested known-body attribution through the existing canonical lifecycle
owner and retain unknown-body refusal. No second walker, classifier, collector, parser,
migration, compatibility bridge, retained affected legacy, evidence budget or deferred
body/fresh-execution contract is authorized. The original reviewer will perform the scoped
re-review after the terminal fix report. Task63 acceptance, publication, main integration,
UI/recipes/workers/Actions and E3 remain open. No Issues were created or reused.

**Fix round1 independently accepted:** Root verifies the actual first four command/raw pairs
and all312 captured source copies. The initial filter matches zero tests and is setup only.
The duplicate iteration and duplicate child-index controls then fail semantically with4
valid controls passing; unchanged test bytes pass all6 after canonical bounded decoder
correction. First-success, failure and cancellation remain admitted with their actual partial
children. The nested authored load/reference positive then fails admission with3 refusal
controls passing. Subsequent correction reaches storage, where snapshot decode still fails:
attempt05 has3/1 and focused06 has42/1. Their names do not turn those semantic failures into
GREEN. The existing compactor must retain the finite load acknowledgment identity needed
for the same canonical nested attribution, without retaining arbitrary successful payloads
or introducing a loaded-body store. Root verifies that stronger storage-loss RED at07 and
unchanged test bytes passing4/0 at08. Current focused native09 passes144/0 with1 optional
SDK disk handoff ignored, shared10 passes86/0 across3 files, and the final actual-SDK owner18
passes51/0. Its existing fixture now covers inline and nested execution, rejects a mutated
application before results/completed IDs change, and compares original receipt/invocation
through storage, restore and export. This remains actual SDK Off under fake HTTP/WS, with
no live connectivity, Native completeness, body-hash or fresh-scope claim. Shared12,
maintained17 with1,478 files/zero errors and corrected native20 pass; prior owned typing and
unsupported CLI setup failures remain preserved. The unchanged original reviewer harness
source21 now admits the valid loop/nested recipe and rejects the duplicate. These raw
results bind the same corrected production source.

Root reads the complete22,558-byte fix append, preserving the199,168-byte report and original
176,610/42,967 prefixes, and verifies78 actual before/current/frozen owners,6 fix differences,
23 command/raw records with1,794 captured source copies and9 auxiliary objects. The original
state baseline remains unverified; its exact current fix preimage is captured and unchanged.
No production file, migration, retained predecessor, parallel collector or increased bound
is added. The internal requirement analysis replaces its single-consumer entry collector;
independent capability collection remains. The private package/no exports/maintained barrel
investigation found no published API or independently required consumer to retain that
operation. This is finite current attribution, not a claim of immutable executable identity.

Scoped style22 reports12 cognitive/unknown/callback review signals; the writer's full-file
manual dispositions require independent judgment. Named maxima58/53 and ten unique
LanguageService definition edges are supporting observations, not standards waivers or
native IDE/live skill telemetry. Root prepares a221,145-byte full-context six-owner package
from the actual fix preimages and releases the original reviewer for combined SPEC/QUALITY
and explicit dispositions of both findings. The other11 originally reviewed owners are
unchanged; no duplicate review seat or broad suite rerun is requested.

The original reviewer returns SPEC Approved and QUALITY Approved with both original
Important findings ADDRESSED and0 remaining findings. Root reads the complete24,126-byte
re-review report, verifies its identity and all78 unchanged current sources plus HEAD/index,
and records Task63 local acceptance. The review independently judges all12 current style
signals and complete six-file closure; it executes no test/check/harness again. This closes
finite admission/preservation only, retaining the historical state preimage limitation and
all broader evidence limits. The continuation remains unstaged, uncommitted and unpublished.
Body/fresh-scope guards, visible and operator propagation, main and governed E3 remain
required. No Issues were created or reused.

A bounded post-acceptance source refresh is released before the next semantic RED. The
prior body/replay audit's55 source rows have49 unchanged and6 changed identities: requirement
analysis, protocol, service/restore and the two affected SDK/distributed tests. Include the
new canonical admission policy, whose finite load acknowledgment and original-attribution
checks may close earlier candidates. Reuse unchanged observations, update only affected
caller/dataflow facts, and distinguish remaining gaps from corrected or unproved behavior.
This is source preparation only: no test execution, future API selection, migration,
legacy retention, new store or Task64 implementation is authorized by the audit.

### Task 64: Accepted recipe intent and execution after reassignment or reload

**Status:** The implementation, correction round1, five CI fixtures and callback-admission
correction are independently accepted locally. Latest affected runtime corpus is227/227;
typing, navigation, formatting and headless checks pass. Exactb0 hosted CI confirms the
callback fix with13758 unit passes/12 skips; every selected correctness job succeeds.
Static retains the19 reviewed findings. The final local style publication/checker correction
passes168 tooling cases and the full changed-style gate. Independent SPEC/QUALITY review
approves the complete three-owner slice with no findings; hosted style validation remains
required after prompt feature publication. Tasks61–63 retain their local acceptance. Draft PR645 publishes each
coherent accepted slice; visible controls, workers/Actions, B01–B06 and governed E3 remain
mandatory. The following retained records describe earlier evidence and corrections;
the final accepted observations and remaining gates appear below.

The first actual SDK/controller witness now fails semantically: genuine queued load A and
its serialized acknowledgment succeed, then local replacement B with the same recipe ID
executes `replacement-B` and applies Off/run in the real SDK before controller admission
refuses its mismatching body token. The unchanged-A control passes. Exact focused command
exits1 with1 failed,1 passed and51 filtered tests; root reads the entire raw output and
verifies109 execution-time source copies, with only the existing SDK test changed and
production still equal to the accepted preimages. This proves unintended execution before
correct report refusal, not accepted wrong metrics or a fresh E3 result. Other candidates
remain tests-in-progress; no production/public field/body-hash/store choice is released.

The inline caller-mutation witness also fails semantically: after distributed creation and
successful staging of A, replacing the caller-owned command with `inline-B` causes that
actual SDK connection to execute with applied Off/run, and its completion is accepted as
a passed distributed run. Direct-inline A and staged-inline A controls pass. The focused
command exits1 with1 failed,2 passed and53 filtered tests; root reads the entire raw output
and verifies109 execution-time copies with only the SDK test changed. Mutating the
top-level manifest capture scalar remains Off, so that already-correct normalization is
a control rather than a new failure. Nested Configure mutation is being witnessed
separately. Production remains frozen and no replacement implementation is selected.

The nested Configure witness now proves the remaining configuration alias: mutating the
caller-owned Off value to Native after create/stage reaches the real SDK as applied
Native/step and is accepted. The Native fixture receipt explicitly has partial coverage;
this is configuration application evidence, not a homogeneous Native cohort. Off controls
pass. The first combined consumer attempt retains three semantic failures and four
unfinished setup attempts separately; setup is not counted as RED.

After infrastructure setup is corrected without production changes, the actual maintained
agent prefix/reload callback/session storage/later registration/suffix sequence executes
the SDK. Root-only Off and recipe-only Off both become applied Signaling/product-default
and are admitted; explicit step Off passes. The original deadline and a new document
time origin are verified. This focused command exits1 with3 failed,1 passed and58 filtered
tests, with116 execution-time source copies verified. Its interactive observation also
shows old resumed IDs skipping new B dispatch/effects and actual same-run replay refused
for inconsistent flags. Root requires correcting that test's stale admission/replay
expectations to desired fresh B acceptance and coherent same-run acceptance before GREEN;
the test must not pin the observed bug while expecting a new effect. Malformed historical
relabeling remains a separate refusal control. No Task63 review is reopened.

The corrected interactive witnesses preserve the controller's intentional run-global
command-payload conflict rule. Run-only and run-plus-agent reassignment can legitimately
queue the colliding ID as fresh work; agent-only reassignment in the same run instead
checks ownership of advertised completed IDs and authentic conflict refusal. Do not
invent a fresh same-run/different-agent collision contract. Actual reconnect producer
incoherence is a separate witness: old invocation/receipt and no duplicate effect remain,
but outer replay true with absent inner replay is refused and must become truthful
coherent replay. Unchanged active and retired historical SDK measurement controls pass;
their exact trace and eligibility limits belong in the phase report.

The expanded SDK test owner is reported at1,710 adjusted lines above its real1,500-line
navigation backstop, with cognitive load279 requiring separation review. This is a
closure issue, not a waiver. Root directs consolidation of repeated protocol execution
and identical domain fixture setup in place, preserving coverage and original frames,
receipts, effects and decisions. A direct named dispatch/decode/execute/serialize/admit
helper may own that actual protocol/side-effect boundary; pass-through chains, copied
setup, artificial line compression and moving the private harness merely to avoid closure
remain disallowed. Freeze the current RED before test refactoring and run only changed
focused witnesses. If coherent consolidation cannot close the limit, report the actual
attempt, remaining facts and concrete alternative before any exception decision. No
persistent size exception or new owner migration is approved. Production remains frozen.

The tests-only implementer completes DONE_WITH_CONCERNS. Root reads the complete17,267-byte
phase report and verifies both final119-owner execution inventories, current test identity,
original preimages and unchanged production/HEAD/index. Coherent in-place consolidation
preserves eight semantic failures and ten passing controls; the final two-row correction
keeps one genuine replacement-effect failure and one strict A control while allowing
truthful admitted failure evidence before effects. The complete report and exact source,
raw commands, counts and limits are retained in the task workspace; the85,599-byte combined
raw packet is assessed through its decoded structured witnesses and assertion/count
records, not claimed read in full textual form.

Current test-owner facts are1,661 adjusted lines above1,500,2,308 physical lines and
cognitive load242. The code is typed/formatted, but warning-only scanner exit0 does not
close that real backstop. No persistent exception, migration, extraction or copied setup
is approved. Retired and active SDK replay controls trace exported snapshots through the
actual historical timing consumer, which deduplicates command IDs and retains two stage/start
samples without claiming a new connection. No fresh-retired-cache RED is justified.

Root releases a bounded design-only followup to the same implementer for the four proved
policy/lifecycle corrections. Name exact current owners, any genuinely necessary public
shape and verified consumers preserved before choosing product code. Prefer compatible
existing contracts, one cache/store/parser, immutable accepted nested intent, pre-effect
body selection/refusal, scoped completion/replay ownership and root/recipe reload capture
propagation. A genuine breaking or standards exception decision must be concrete; no
routine compatible correction requires invented migration or retention. GREEN and final
closure/independent acceptance remain unreleased. Task65/worker/Actions/E3 still required.

Root subsequently reads the complete bounded proposal and releases the four corrections
through the same writer. The accepted design reuses `snapshotExecutableRecipe` and
`snapshotExecutableCommand`; adds optional `recipe.run.expectedRecipeBodyId` for the
accepted load instance and optional `execute(command, controlIdentity)` for cache ownership;
keeps one runtime result cache plus control-client completion ownership metadata; and
carries root and recipe capture modes separately through reload segments. Existing
finite queued-load/ACK resolution serves dispatch lowering and result admission. Queued
fingerprints, original invocation evidence and intentional run-global command conflicts
remain authoritative. Older strict schemas receive no migration or ignore-field fallback.

Assignment is captured at admission and settlement: finishing A work cannot become B's
completion, and registration cannot advertise A or manual/child cache entries as B work.
A changed address must not force a compatible SDK reset or erase historical evidence.
Routine compatible corrections proceed; any concrete public breaking decision or genuine
remaining standards exception is reported for human direction. Existing RED packets are
preserved; focused GREEN, affected owner suites and package/application checks precede
independent review. No extraction, copied setup or size waiver is approved. Task65 and
worker/Actions/B01–B06/E3 remain mandatory.

Before changing the cache/client, the implementer witnesses asynchronous reassignment
through the maintained SDK ICE port: A connects after the client has switched to B;
A's result and result-event are emitted under B, B's reconnect advertises A's root as
completed, and genuinely new B work never dispatches or connects. The focused test exits1
with1 semantic failure and65 filtered controls. Root reads the frozen witness and all five
failure/assertion sections. This expands the ownership correction to settlement and event
routing, with no retry, initial ICE cause or E3 claim. The original eight failures/ten passing
controls remain separate preserved evidence.

The first focused GREEN passes19 tests with47 filtered tests. Further real SDK TDD
witnesses extend accepted-input ownership to inherited connection defaults and report
ownership when assignments reuse a root ID. The latter proves an old A report can precede
B's root-result event; selecting cumulative history by matching string IDs is insufficient.
Use current-cache original-result ownership metadata rather than a second result store.
Periodic cumulative runtime statistics remain a verified diagnostic contract. An attempted
scoped-stats projection broke that contract and is corrected without changing its shape.
Final verification must cover the last snapshot, heartbeat and dispatch-policy edits;
earlier GREEN alone does not prove that final source.

Root approves a concrete ordinary structural closure after the current behavioral and
application checks: one canonical actual SDK composition fixture, the existing capture
conformance owner, and a distinct control-consumer lifecycle test owner. This replaces the
earlier overly broad extraction restriction with a responsibility-based decision. The
shared fixture owns real SDK dependency construction and cleanup; tests retain direct
protocol, effect and admission assertions. Remove the old private setup when its ownership
moves, with one implementation and no migration, forwarding or compatibility path. Full
changed/support-file closure, the preserved test corpus, canonical structure/style facts
and concrete owner-to-effect-to-assertion navigation must pass before acceptance. A size
waiver is not the default. Outgoing-envelope translation belongs in the existing pure
queue-policy owner; controller state mutation stays in its service. Both changes remain
inside Task64, with Task65 the only next concrete slice.

The completed post-Task63 source refresh is retained at
`.superpowers/sdd/2026-08-06-rallar-rtc-performance-baseline-plan/next-recipe-body-freshness-post-task63-refresh-report.md`
(31,018 bytes, SHA256 `3500016467dbf4107dbbf7dc9facc5580c3d9717d1aeca912cfd807e85fd5fa1`).
Root read the entire report, verified all60 current source identities and29 overlapping
accepted Task63 identities, and froze the observed sources. The canonical admission policy
now requires a genuine preceding successful queued-load acknowledgment for a bodyless
required-capture run. It also refuses mismatched outer/inner replay flags. Neither finding
proves that unintended effects were prevented or that newly assigned work executes.
This audit executed no tests and selected no future public contract.

**Initial release: tests only, before production changes.** Use the existing public
controller, runtime, actual SDK and interactive/reload consumers as applicable. Read the
fresh report rather than importing earlier presumed failures. Preserve accepted Task61–63
behavior and record exact current preimages before changing a test or support file.

1. Establish a successful controller-queued load A with its actual acknowledgment, followed
   by a serialized bodyless run and observable execution/admission. Pair it with local
   replacement B using the same recipe ID and different observable steps. Prove accepted
   A executes, or the substitution is refused before B's effects; a late receipt refusal
   alone does not prove intended execution. A health-only reference with no known body is
   already refused and is not a new RED.
2. Through the injected controller service, create/stage an inline body A, then mutate the
   caller-owned body/configuration to B before start. Observe executable steps and capture
   setting independently of the echoed command. Accepted intent must remain A or be
   visibly refused before unintended execution. Preserve direct-inline and known-load
   positive controls. Do not choose copying, hashing or a new field before this witness.
3. Exercise the actual interactive consumer retaining its runtime across run/agent
   reassignment with a colliding command ID. Distinguish correctly refused mismatched
   evidence from newly assigned work that never executes. Include legitimate coherent
   same-run replay/reconnect and bootstrap resume controls. Do not turn all replay into
   fresh execution or erase original attribution to manufacture a passing test.
4. Exercise a real prefix/reload/later-registration/suffix. Under host/default Signaling,
   root-only run Off and recipe-only Off must reach the actual suffix SDK as Off; use an
   explicit step Off as a positive control. Preserve existing sequencing, deadlines and
   scope attribution. Materialized commands alone are not application evidence.
5. Trace the actual measurement consumer before asserting any rule for retired SDK replay.
   Truthful coherent historical replay and compatible live/pending connection reuse remain
   valid behavior. A new freshness rule requires an actual consumer and semantic witness;
   the absence of a new connection alone is not a failure or an initial ICE root cause.

Retain setup failures separately from semantic RED, with command, exit status, relevant
raw output and source identity. Keep tests focused and use the actual effect/application
boundary; synthetic matching receipts alone cannot prove fresh execution. Report any
already-correct candidates as controls. Stop for root review of the witnessed RED before
changing production, serialized/public contracts or selecting an implementation shape.

**GREEN and acceptance, after the witnessed scope is released:** Choose one canonical
owner for each demonstrated policy/lifecycle boundary, functional decisions within owned
stateful shells, and direct dataflow. No migration code, affected retained legacy, parallel
stores/decoders, aliases or duplicated policy. Apply full touched-file/support standards
closure and preserve independently verified ordinary bodyless runs, same-run replay and
compatible reuse. A genuine public compatibility decision is presented concretely under
repo guidance rather than guessed in advance. Use focused surface checks selected by
`rallar-testing`, then one covering independent SPEC/QUALITY review; do not repeatedly run
unchanged broad suites. Preserve raw failures and existing source limitations. Root owns
this plan; the task implementer owns tests and released product/support work. No commits,
publication, main operation, E3 measurement, retry/watchdog or CRDT redesign in this release.

**Independent review and hosted CI correction:** The same reviewer read all17 Task64
owners against the accepted Task63 source preimages and requires four corrections:

- An asynchronous reset admitted to A must not clear B's configuration, loaded body,
  cache or state after B starts. Fence the reset's continuation and notifications with
  its captured owner, not only its eventual result commit.
- Preserve owned child-result progress before a root settles. The current root-only
  event filter drops a receiver's successful connect event; the verified ALM barrier
  therefore starts its sender only after the receiver root completes. The preserved WS
  artifact corroborates that ordering in all six pairs. Keep root completion/report
  ownership separate from legitimate descendant diagnostics.
- Own nested assertion operands at acceptance. A caller changing `between` bounds after
  enqueue currently changes whether an actual value passes and a following connect
  executes. Audit analogous executable match/condition values in the same snapshot
  owner; outgoing application payloads remain opaque.
- Refactor the snapshot's135-line named function into coherent option responsibilities
  in place and remove its identical fault-carrier arms. No function exception, second
  copier, migration or retained predecessor is authorized.

Witness the three semantic failures first, then implement the minimum corrections and
return to the same writer/reviewer. Every changed human-authored file is reviewed and
remediated in full; support files modified by that work enter closure recursively;
independent untouched code remains outside closure. Validate actual consumer behavior
and the affected package/application separately. Publish each coherent validated fix.

The three independent semantic tests now fail against unchanged production, with two
unchanged controls passing and no setup failure. Root verified the tested source copies
and released minimum GREEN. Descendant progress needs authentic execution attribution:
an optional local event field carries the admitted run, agent and root command identity.
The canonical runtime stamps it from captured admission/child execution; caller metadata
or a public event input cannot forge it. The client matches its current address and
admitted root while retaining the child command ID. Root completion, result/wire shapes
and the protocol version remain unchanged; no parallel ownership store is added.

Hosted browser/app and both Recipe Console checks, API standard/cluster recipes,
Postgres integration and both scale checks pass. The release remains failed: three unit
and three Deno failures, changed-style findings and ALM observation. Five unit/Deno
fixtures contain malformed, unowned or inconsistent-address facts and must be corrected
to current finite contracts while preserving their artifact/deduplication/restore
assertions. Do not reopen permissive admission or add a past-format reader. The headless
bundle measures320.620KiB against its319KiB budget. A bounded before/current comparison
measures319.268KiB before Task64 and320.620KiB now; compressed attribution is not additive
per file. Check meaningful snapshot/ownership consolidation first and retain the budget
until the corrected complete boundary is measured. The existing adjustable packaging
policy in Section11 retains `floor(measurement)+1` with explicit PR disclosure: apply
only that minimum cap if still exceeded, preserving every forbidden-dependency assertion.
This is not a change to E3 workloads, counts, limits or acceptance. Warning findings require their
actual cohesion/boundary judgments, not a metadata-only waiver. The next useful outcomes
are the Task64 corrections and affected CI closure; visible/persisted controls follow
acceptance. Neither CI nor this review is E3 evidence. No Issues were created or reused.

**Correction round1 accepted locally:** The original reviewer returns SPEC compliant
and QUALITY Approved on all seven changed owners, closing its four Important findings.
Late reset continuation and notification now use captured admission. Authentic Event-owned
run/agent/root provenance restores descendant progress while caller/forged provenance is
stripped, stale ownership is suppressed, and only completed roots are advertised. The
single accepted snapshot owns nested assertion/wait/CRDT comparison decisions while
outgoing application payloads remain opaque. Meaningful option responsibilities replace
the135-line function and duplicate fault arms; the dispatcher is55 lines and every named
function is at most60. No migration, affected retained legacy, second ownership store,
protocol fallback, source move or CRDT algorithm change was introduced.

The additional match-policy RED has two failures/two unchanged controls; forged-event RED
has missing genuine progress and wrongly published manual provenance. Final checks pass
140 consumer tests in nine owners and177 controller tests in four owners, package/test
typing, app build, exact formatting/diff, named-function and six compiler-navigation probes.
Root verifies all130/132 frozen copies against current final source. The complete headless
boundary measures320.7783203125KiB; the authorized minimum calibration changes319→321
and its test passes with all forbidden-dependency checks intact. The existing app chunk
warning and dependency-only test typing skip remain disclosed; this is no optimization
or E3 acceptance claim.

The first full-range changed-style observation fails with17 findings; exacte088 hosted
publication reports19, adding two already-reviewed malformed-fixture untrusted boundaries
in tuning tests. Each needs its actual whole-owner cohesion/normalization judgment and
exact current publication closure under the existing reviewed-disposition policy; no real
violation may be waived. Production decoder/admission behavior is authoritative. Keep all
historical failures; neither green local tests nor skipped RTC integrity supplies E3 evidence.

**Five CI fixtures accepted locally:** Current finite lifecycle/error, actual queued
socket dispatch, ordinary-result admission and coherent restore identities now reach their
intended artifact boundaries. The same reviewer approves all four complete test owners.
The later two ordinary-compaction failures were obsolete test coupling: current assertions
keep exact finite child lifecycle and explicit payload omission while full group payloads,
rollup, zero stored fleet reports and collision isolation remain strict. The167-line named
fixture factory is removed in favor of immutable serialized data in the same owner;
every literal and assertion is preserved, with no new helper/file or exception. Final
17 artifact tests, eight unchanged tuning tests and14 native API/group tests pass;
affected typing/format/whitespace and compiler navigation pass. Production, protocol,
compaction, decoder/admission, timeout values and registry are unchanged.

**Fresh hosted correctness and remaining callback regression:** Release
[37643157331](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37643157331)
checks out exactce6f81a98185940985650738c1d77f4246e80892. Its actual ALM run passes the
baseline WS, RTC and RTC-with-WS-fallback smoke cases; nine other families are intentionally
skipped. Headless passes. Unit output has13747 passes/three failures/12 skips and the
controller has357 passes/three failures/one ignored. The five fixture failures are now
locally corrected; the remaining unit failure is a genuine runtime ordering regression.
The new top-level command-ID callback runs before loaded-body admission, so a reentrant
load substitutes replacement/Native for accepted first/Off. The unchanged original matrix
reproduces one failure with running/invocation-ID controls passing. Its later effect
assertions were not reached on the failed case and are not extra witnessed failures.
Capture command admission before external effects; test analogous cache-owner/address
and capture-default reads before changing them. No new API/store, callback-wide repair,
retry/watchdog, CRDT change or E3 claim follows from this evidence. Preserve all failed
source-bound records and return to the same implementer/reviewer for minimum correction.

**Fixture checkpoint confirmed by hosted CI:** Release
[37648214097](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37648214097)
checks out exacte0886ae22549a92cae5ddfbff6eca57c67e87ee4. Unit13750pass/one failure/12skip
leaves only the existing reference-run command-ID regression. The controller has360pass,
zero failures/one ignored; shared-server has603pass/zero failures. Headless, browser/app,
Recipe Console, ALM observation, API recipes and Postgres/scale checks report success.
RTC observation integrity remains intentionally skipped. The static gate reports19
new/worsened findings; its two additional fixture-boundary prompts are preserved for exact
publication closure. This verifies fixture correctness rather than governed E3 acceptance.

**Additional admission RED:** Seven tests use the current runtime and actual executor/
context boundaries:three failures/four passing controls. A command-ID callback that switches
from A to B lets outer A work execute, cache and publish under B; a same-address Configure
changes accepted Off to Native; an owned event-ID callback appends a late A-provenance event
into current B state. B's actual work, later capture defaults, unchanged-address execution
and normal owned events remain controls. The event finding proves a current-state append
failure, not that client B forwards the A-attributed event. The minimum correction binds
accepted ownership/body/selection before ID generation and checks original event ownership
after callback-capable construction. Keep the original body-binding RED and these failures
append-only; public contracts and manual event behavior remain current.

**Callback correction independently accepted locally:** The same reviewer approves both
complete runtime/test owners with no findings. Accepted body, cache owner, address and
applicable capture sequence are captured before command-ID generation; each child still
admits its current loaded body, and an owned event rechecks ownership after construction.
Replay, Configure defaults, child attribution and manual global events retain their
verified behavior. Final227 cases in16 files, package/scoped test typing, formatting/diff,
expanded class/callback spans and five compiler-definition probes pass. The cohesive
50/55/55-line methods receive explicit separation review; no named function exceeds60.
Headless measures320.94921875KiB and passes the unchanged321KiB cap. Root verifies all141
frozen source copies in every final packet. Only runtime and its existing test owner change;
there is no new public contract, support file, store, migration or affected retained legacy.
Hosted [37651904166](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37651904166)
checks out exactb0ecf928171f6f5246f96662f6952b5664eb1c8c and confirms13758 unit passes/12 skips.
Browser/app, both Console shards, native controller, tooling, API recipes, Postgres and ALM
checks succeed. Static alone reports the19 reviewed findings. RTC integrity is skipped;
no E3 acceptance or generic callback-safety claim follows.

**Style publication and tooling correction:** Publish only the19 exact previously reviewed
entries: nine current cognitive caps and ten actual untrusted-boundary keys. The original
full-range gate fails on those19; after applying the entries, it exposes one genuine checker
defect. The universal behavior-free data-table discount is incorrectly gated by TypeScript
cognitive eligibility, so the declarative JavaScript registry is measured at1318 physical
lines rather than409 adjusted lines. A maintained real-CLI test fails for JavaScript while
eleven controls pass. Remove only that eligibility condition from navigation measurement;
TypeScript cognitive/export metrics,1200/1500 backstops, behavior-containing literal refusal,
thresholds and matchers remain unchanged. Final five-owner tooling corpus passes168/168,
the full changed-style gate has no new findings, and formatting/diff/navigation checks pass.
The same independent reviewer approves the complete three-owner slice with no findings;
no new exception, helper, migration or legacy path is introduced. Hosted confirmation of
this style checkpoint is complete in d586: run 37655992935 passes repository style
and all selected correctness jobs. The next static stage refuses four individually
unclassified owned-network assertions. Preserve both actual REDs and all earlier
adverse evidence.

**Network-interaction classification accepted:** The exact committed 9d→d586 checker
reproduces four missing classifications. Three domain contracts now link the four
unchanged socket-count/absence and excluded ambient-fetch assertions to their
independently observable effects. The same reviewer returns SPEC compliant and
QUALITY Approved. Existing policy, tests, tools and prior registry objects are
unchanged; current-file validation and formatting/whitespace pass. No constructor-time
configuration-order claim, legacy waiver or artificial test is added. Classification
checkpoint a017c10e is published and its composed committed-range GREEN passes at1bbb.

**Repaired-parent composition accepted locally:** The continuation's actual conflict
with published parent 15efff00 is confined to this plan. Preserve the continuation
status and complete parent facts; the six code/test/policy owners compose without
a hand repair. The same reviewer approves their audience/schema/validator/snapshot
alignment and preserved capture intent. Actual SDK capture, ALM, delivery and schema
pass 183 cases; package typing and 1488-test typing pass with zero debt/errors.
The combined headless bundle measures 322.617 KiB and needs the existing minimum
adjustable cap 323. Its original 321-cap failure is preserved; final headless boundary,
all forbidden imports and format/diff pass. Main's retired invalid-fallback contract
and two obsolete occurrences stay removed; current audience contracts and the
three new I/O contracts/four exact classifications survive. No workload or other
limit changes. Feature merge1bbb is published; exact current-parent style/coupling gates
pass with all nine current candidates individually classified. Fresh hosted combined-source
acceptance is complete at1bbb through37664555375/attempt2 and the matching Formation/Medium
trees. Its first setup timeout remains preserved. Visible UI, workers/Actions and B01–B06/E3
remain required.

### Task 65: Visible recipe controls and persisted intent (active)

After Task64 acceptance, use the refreshed Console/local authoring and reusable
recipe/manifest consumers against its accepted source. A53-source audit reuses unchanged
UI owners and confirms missing visible run-override forwarding in Console new-run and
local recipe Run. Authored JSON and stored Console manifests already retain recipe intent.
Existing Save persists endpoint/scope/timeout preferences, and Analyze import/Execute
export handle run evidence; a dedicated custom saved-recipe store was not recovered in
the bounded owners. Do not invent one or treat evidence import as executable recipe import.
The next two semantic outcomes are visible Inherit/Off/Signaling/Native choice reaching
actual submission/application or visible refusal, and authored intent surviving existing
Load/Copy/storage/restore/repeat paths without a run override rewriting it. New effects
and owned invocation/application evidence must distinguish fresh work from truthful replay.
Follow current canonical owners with semantic TDD and actual consumer controls; select no
new API/store, migration, retained legacy or duplicate policy before the witness. Generic workers, spawned/external/mixed/no-spawn recipes and GitHub
Actions propagation remain mandatory later outcomes, together with B01–B06/E3. This
slice does not narrow the original goal.

**First Local Workbench witness:** The current1bbb refresh verifies50/53 unchanged
source bindings and all14 unchanged guidance bindings; the three audience/schema deltas
preserve capture intent. Tests-only RED uses the maintained real browser/store Load path:
authored Native recipe and Off step load unchanged, then the visible run capture selector
is absent. Actual exit1 has one semantic failure and two passing observer/report controls.
Submission, SDK application and receipt/refusal assertions are not reached. Root verifies
the complete frozen test, command, raw output and unchanged production inputs, then releases
the minimum control implementation and further semantic RED before forwarding changes.
The selector-only GREEN is followed by a second semantic RED: explicit Off is selected
and Run completes, but the accepted root invocation has no run capture intent. Minimum
forwarding then preserves the primitive run choice through the existing store and
canonical recipe.run command. Undefined Inherit is omitted; explicit Off is retained.
Authored Native recipe and Off step remain unchanged. Existing SDK composition tests
observe fresh run identity, effective receipt/application origins and truthful historical
replay; application-unavailable produces typed RALLAR_RTC_CAPTURE_UNVERIFIED refusal
without a completion effect. These SDK tests mock network/bootstrap services and close
their owned connections to distinguish fresh application from replay. The browser witness
uses the real UI/store with the simulated provider, not live ICE/channel establishment;
it does not independently prove visible real-SDK refusal or Native completeness.

The five canonical source/test owners undergo complete touched-file closure. The sole
Workbench importer follows the required kebab-case filename; the old filename and private
effectful resolveInitialBootstrapConfig name are removed without aliases or migration.
In-file view/action composition and its explicitly owned React draft shell retain the
canonical shared capture parser. Maximum named/helper span is48; all seven cognitive and
callback prompts are individually reviewed. Final correction-source checks pass32 cases
in four SDK/store owners, one Local browser witness,1488 maintained test files with zero
errors/debt, scoped browser typing, app typecheck/build, format and diff checks. The
existing large-chunk build warning remains disclosed. The same independent reviewer
returns final SPEC compliant/QUALITY Approved, closes both corrected Minor findings and
verifies all eleven final input bindings and eight actual exit-zero check packets. The
pre-correction maintained style result stays distinguished; exact corrected committed-range
coupling passes with all nine candidates classified. The first corrected committed style
gate flags only the store's reviewed cognitive magnitude51 against its existing exact-owner
cap50. The completed whole-store cohesion review is confirmed by the same reviewer. The
exact bounded51 disposition and its concrete cohesion comment now have independent
SPEC/QUALITY approval under the current human style guide. All other inventory/matcher
bytes and runtime behavior remain unchanged;88 focused checker cases pass and the complete
support-file scan has zero findings. Global thresholds remain unchanged. The failed result
is retained. Final committed style/coupling gates pass at634c47fe against current parent15eff,
with all nine coupling candidates individually classified. Commits e69f1318b and634c47fef
are pushed together; the PR body and exact remote head are verified. The Local legacy scan
resolves the two active consumer paths and three canonical event-translation imports/call;
the old Workbench filename is removed. No newly retained legacy is approved or added.
Delivery ready returns STOP_WRONG_BASE for the intentional stack; no main operation is done.

**Console next-run RED released:** At clean published634c, revalidate the existing
Console workflow/manifest/browser consumers and unchanged guidance. Release tests only
for the earliest real visible capture-choice/submission gap; freeze production until root
verifies actual semantic RED and its source/output bindings. Stage/Start must retain the
accepted run and authored recipe/step intent. Do not add a new store, protocol, migration,
copied policy or manufactured future-API failure. Required actual application/refusal and
the existing persistence/repeat paths stay explicit, together with all remaining full-goal
outcomes below. No Console GREEN or hosted acceptance is claimed by this release.

Root verifies the Console tests-only RED at634c: the maintained real SPA reaches the
Composite Evidence recipe, two safe targets and an unchanged recipe manifest with omitted
run capture, then fails because the visible capture selector is absent. Actual exit1 has
one intended failure and two unchanged passing controls. All twelve immutable preimages
and current input copies agree; the test changes only21lines. Resolve/Create/Stage/Start,
selected-mode submission, SDK application and typed refusal are unreached. Existing HTTP
interception proves SPA/request-boundary behavior rather than actual controller or worker
execution. Root releases minimum selector GREEN and a further genuine forwarding RED
before changing manifest forwarding.

The selector-only GREEN passes the maintained browser witness. The next semantic
RED selects Off and clicks the actual Resolve control, then finds omitted run capture
at the owned HTTP request rather than the expected off value. Actual exit1 retains
two passing lifecycle/target controls. Create and downstream application assertions
are unreached. Root reads both raw results, the complete changed diff and generated
manifest flow, and verifies all twelve frozen input/copy bindings before releasing
minimum forwarding GREEN through the existing canonical manifest builder. Inherit
must remain omitted; selected capture participates in the existing manifest fingerprint
and accepted run truth, and recipe/step content must remain unchanged. The initial
selector setup/type-placement error is retained separately from semantic GREEN.
The first forwarding GREEN then passes all three maintained browser cases: selected
Off reaches the owned Resolve and Create requests, whose recipe bodies equal the
original. Root verifies the twelve immutable GREEN input copies, raw actual exit0 and
minimal canonical builder/workflow diff. This accepts that scoped request witness;
all-mode, omission, locked lifecycle and full touched-owner closure remain required.
The plan-only checkpoint ed8ba5848 is published without including incomplete source.
The next browser pass covers all four choices and the fresh-run control: five cases
reach Resolve/Create/Stage/Start, explicitly omit Inherit, invalidate old resolution
after a mode change, restore valid evidence for the identical intent, and lock the
accepted selector. Twelve initial manifest cases pass authored Native/Off root selection
and capture fingerprint assertions; their step fixture contract is corrected below.
Root reads the actual checks, independent assertions and immutable input copies. These
checks pass before refactoring; full touched-owner closure and final validation/review
still gate Console publication. The mistyped Vitest configuration startup failure
is preserved separately from the corrected exit-zero manifest check.
Subsequent scoped typing catches an invalid authored fixture: its added steps field
does not belong to the recipe contract, which uses commands. The earlier step identity
claim is withdrawn until a canonical-command fixture passes independent preservation
and validation assertions. Browser fixtures also omit three mandatory group assertion
counters. Preserve both owned failures, correct their actual contracts, then rerun
affected checks. Third-party declaration diagnostics retain the existing maintained
typecheck policy; no new suppression or skipLibCheck is authorized.

Fresh hosted release acceptance at634c is independently bound to Branch run37678344974
attempt1: all selected core lanes, publication and the final broad gate pass without
evidence reuse. Fifteen completed job logs record the exact634c checkout; topology
records tree279a83f9a53e82f2438c037850194fa9eb92a0ec. Formation37678344373 and
Medium37678344447 pass on synthetic db54efba33a99020296b522c56ae4771034f0a2b,
whose parents are15eff and634c and whose tree is identical. Branch is terminal cancelled
at20:28:54Z solely because the separate nonblocking ALM job exceeds its30-minute
setup timeout. npm installation completes before Playwright system dependency setup stalls
on Ubuntu mirrors; observation never starts. The lower-level mirror/transport cause
remains unproved. Preserve the failed attempt; no rerun, ALM or Native transport
acceptance, or E3 completion is implied by the selected release acceptance.

The touched browser owner has genuine closure work: adjusted1650 exceeds the1500 test
backstop, cognitive149 requires separation review, installLifecycleControl spans328lines,
and distributedRun has four inputs. Apply current structure/adaptive/code/testing guidance
before choosing the smallest truthful in-place remediation. No relocation of predecessor
implementations unchanged, parallel harness, metric compression or unapproved persistent
exception is authorized. Remediate the complete touched owner and recursively changed support before
publication; independent untouched source remains outside closure.

**Code-fact ownership refresh:** In-place refactoring passes all29 maintained Execute
browser cases and12 manifest cases, removes every named function/method over60lines
and the four-positional fixture builder, and reduces cognitive magnitude to121. The
browser still has1646 adjusted lines against its1500 backstop. Independent complete-owner
review finds repeated snapshot/detail HTTP handling in the lifecycle fixture, live-read
installer and untrusted-control scenario, plus a duplicate250-run/240-target pressure
generator and an unused import. No independent adversarial assertion may be removed.
Reuse the existing createExecuteScaleSnapshot while preserving scenario freshness;
Monitor, Tune and scale HTTP owners do not implement Execute's lifecycle and should
not absorb it.

Replace the parallel HTTP fixture implementations with one maintained Execute fixture
owner in the existing browser test directory. It owns route registration, snapshot/detail
serialization, broker/agent-token observations, distributed-run transitions and deferred
request state. Remove the embedded predecessor fixture and redundant live-read installer;
do not copy/export the unchanged class or retain compatibility wrappers. Keep visible
actions, expected payloads, adversarial assertions and abort-ignoring browser fetch
observation in the spec. Untrusted-endpoint construction stays explicit and initializes
no credentials or broker effects. This concrete consolidation narrows the plan's prior
blanket no-transfer interpretation; it adds no migration, legacy retention or duplicated
policy. Validate one lifecycle scenario and one credential-trust scenario from fixture
construction through route/captured request/response/state to the visible assertion,
including deferred release and context teardown. Fully close both owners and recursively
changed support, then rerun affected29 browser and corrected manifest cases, typing/build,
canonical size/structure/navigation checks and independent SPEC then QUALITY review before
the coherent source slice is published.

**Final Console review input:** The actual canonical-command matrix now validates
all manifest choices and independently preserves authored Native/Off commands.80
focused unit cases, app typing and1488 maintained test files pass. The corrected
consolidated browser corpus passes29cases; after moving response calculation outside
the abort-only fulfillment catch, the three affected Stage/deferred/abort cases pass.
The earlier27-pass/two-failure draft and missing-name diagnostics remain preserved;
its Stage timeout attribution is source-plus-trace inference rather than a logged
ReferenceError. Scoped raw browser typing remains exit1 solely for third-party Temporal
declarations under the unchanged maintained policy. Existing color/chunk warnings stay
disclosed. The final spec has1277 physical/1157 adjusted lines and the fixture596;
no named function/method/assigned helper exceeds60. Fresh independent review confirms
coherent50–55-line decisions, fixture cohesion72, the three framework callback prompts
and genuine predecessor/parallel-path removal. Its two Minor workflow findings require
canonical compute names and removal of two unused locals. The actual current-parent
WORKTREE style gate fails only on the new fixture's opaque outgoing JSON serializer;
completed independent boundary review justifies its exact path/rule/symbol disposition,
with no global policy or real standards exception. Coupling over all three touched
test owners passes with zero candidates. Apply these bounded corrections, review the
complete newly touched support owner, obtain SAME-reviewer closure and actual final
publication gates, then publish promptly. This is scoped UI/request/lifecycle proof
through a mocked controller, not actual SDK/native application or E3 acceptance.

The SAME reviewer closes both Minor findings and approves bounded SPEC/QUALITY on
all seven complete source/support owners. The correction changes only two pure
compute names, their direct calls and two unused locals, plus one exact serializer
path/rule/symbol disposition with a concrete rationale. Removing that entry restores
the prior registry byte for byte; global policy, caps and matcher stay unchanged.
The seventh owner's complete review accepts its declarative417 adjusted lines and
10/11-line matching helpers. All15 final frozen/current bindings match independently.
Final83 manifest/workflow/disposition-checker cases, app typing and seven-owner
formatting pass. A correction draft's TS18004 is preserved and corrected by restoring
the still-required draft group. No unchanged browser/build suite is rerun; its evidence
is reused only with the mechanical workflow delta qualified. Root's final current-parent
WORKTREE style gate passes with no new findings. No newly retained legacy, migration
or real standards exception is added. Publish this bounded Console slice promptly;
its approval does not accept the remaining full-goal outcomes.

**Published Console hosted acceptance:** The coherent seven-owner Console slice is
published at5375a5559b447c8dda5b90739f466cfeaee91a27, tree
bf747f19f9ef6cd875b771da192aef823cdd7962. Branch37690497028 attempt1 completes
successfully with fresh broad selection, reuse=false, publication and final gate.
Formation37690496468 and Medium37690496519 attempt1 also pass; actual checkout
965d31055340d3f3c5a6a9270a79ac86764f6dc9 has parents15eff and5375 and the same
Git tree. Eight downloaded artifact hashes match their API and upload records.
The separate ALM job passes ws/rtc/rtc-with-ws-fallback baseline smoke with38 commands
dispatched once, completed successfully and replayed=false. Twelve ALM cases are skipped;
every per-operation cell has only one sample. Bounded event indexes and nonblocking
recipe observations remain disclosed. These are hosted release/smoke results, not
B01–B06/native/E3 acceptance and not acceptance of subsequent dirty Local source.
The earlier634c setup timeout remains preserved and its lower-level cause unresolved;
new smoke success does not explain or replace that failure.

**Existing Local Load/remount independently accepted:** A bounded source audit led to
two separate semantic witnesses against published5375. First, genuine ws-http-smoke
fixture Load passes, then complete custom Native-root/Off-command JSON loads unchanged
but wrongly retains the selected fixture ID. Actual exit1 retains two passing observer
controls. Root verifies all eight frozen input bindings before minimum attribution
GREEN. The existing Load callback now supplies a fixture ID only when complete parsed
content matches the selected fixture. The final adversarial case deliberately reuses
its recipeId with different content; identity alone cannot claim fixture provenance.

After first actual GREEN, the independent remount RED proves all temporary capture
choices preserve the complete accepted recipe, then really unmounts Legacy through the
existing experience route. Browser Back retains the accepted runtime body but resets
the editor to default fixture text. Actual exit1 retains both observer controls; root
verifies the distinct frozen packet before releasing minimum restoration. The existing
Local consumer passes accepted loadedRecipe into the Workbench's lazy editor initializer.
Remount chooses that body once; no restore Load/Run, synchronization effect, second store,
public API, migration or parallel policy is introduced. The independently required
unloaded fixture path remains intact.

Final maintained browser exit0 passes three cases in39.4s. Controls additionally prove
unsubmitted draft preservation after a visibly committed ordinary parent update and
Reset/unloaded reconstruction after a second genuine remount. App typecheck, three-owner
formatting and scoped whole-owner style/construction checks pass; untouched directory
warnings remain outside closure. All35 packet hashes and all eight current/frozen source
bindings are independently verified. Both original REDs remain immutable. Fresh independent
SPEC/QUALITY review approves all three complete owners with no actionable findings and
confirms all four proof manifests. Final current-parent WORKTREE style passes with no
new findings. The coherent four-file source/plan slice is published at
379f8aff5cce8545957d2e46c02787c2eec6443e, tree
5121b406102eed27913f84f13a21df2566276516, with normal feature push and exact
remote/API/PR-body readback. Full Task65 is open.
This proves existing in-memory route restoration through simulated UI and actual runtime
state; it does not establish browser reload durability, copied executable consumption,
independent fresh external effects or actual UI SDK/native application/refusal.

**Executable Copy → Local independently accepted:** The visible Manual history records
Off and Native commands under an explicitly established Global context, then builds the
complete expected recipe independently of the producer. Before real Copy, the test writes
and reads a distinct non-recipe sentinel through the native browser clipboard. Actual
Copy must replace it with the complete authored recipe; that actual text passes the
canonical schema and visible Local Load. Temporary Off/Inherit runs preserve the accepted
body and command intent, produce distinct non-replayed invocation receipts, and genuine
experience unmount/Back remount preserves the complete editor/runtime body.

Two setup failures remain preserved: an implicit-label selector mismatch before commands,
then visible Global room synchronization changing unrelated scope before Copy. Correcting
those test prerequisites yields four maintained browser passes in48.5s. Independent review
then identifies stale-clipboard false-positive risk; the SAME author adds only the two-line
native sentinel precondition and the SAME reviewer closes SPEC/QUALITY without remaining
findings. The affected final witness passes1/1 in16.0s. All eleven frozen/current bindings
match; the accepted Local and observer controls remain byte-identical. Final current-parent
WORKTREE style passes. This is a tests-only acceptance of existing behavior, with no
production regression claimed, manufactured RED, timeout/retry expansion or new store.
It proves simulated-provider UI consumption and real clipboard/lifecycle behavior, not
actual SDK/native RTC application, reload durability or fresh external effects.

**Parent delivery refresh:** Main advanced to94e72f4828e9db5111dc06e4746f1ce09f68ead2,
creating two real PR633 conflicts. The earlier exact main-merge proposal is stale and has
no approval. The feature-only merge979edba8 reconciles the actual null-delete room test
and measured bundle budget, preserving current main semantics and the RTC capture work.
Fresh review accepts both complete owners; focused checks pass332cases and the actual
browser entry measures256666B Brotli within the unchanged251KiB cap. Broader checks pass
480 benchmark-package cases, shared/shared-test typing,1490 test-file typing and the
headless boundary case. Both canonical game builds pass after pinned dependency isolation;
the original missing-plugin setup failures are retained and the lock remains unchanged.
The exact raw-HTTP observation disposition receives SAME-reviewer closure; final current-main
style and classified coupling gates pass. Fresh original-attempt Branch37698502492,
Formation37698502271, Medium37698502189 and CodeQL37698497321 all succeed. Root verifies
all eight artifact digests,20 checkout proofs and the synthetic merge d62c8d2a with
parents94e72/979 and treef5c9cf38. Actual broad execution/reusefalse telemetry is verified;
13920 unit tests pass/12skip, app browser46pass/68skip, then memory full stack7pass.
The actual Manual Native case is skipped in hosted app browser; ALM smoke limits,
nonblocking recipes and skipped RTC integrity remain disclosed. PR633 is MERGEABLE with
native review required; a fresh exact main proposal is prepared and permission pending.
No default-branch operation or E3 follows from this feature reconciliation.

**Published Local/Copy hosted provenance:** Local379f8aff and Copy6a01de7d each have
original-attempt terminal-success Branch, Formation and Medium workflows. Root independently
verifies all sixteen archive digests,36 checkout proofs, published validation receipts and
actual synthetic commit trees/parents. Local Formation/Medium test603137c0 with parents
15eff/379 and tree5121b406; Copy tests a7811ec8 with parents15eff/6a and tree28f68874.
Branch checkout is the respective literal head. This scope does not inherit to the newer
parent979 reconciliation or dirty Native-refusal test. Actual selection/execution telemetry
is separately checked before claiming fresh broad acceptance. The retained Copy Branch
app-browser log actually passes48/skips68 cases, then passes7 memory full-stack cases.
Its actual Manual Native/export/reload/reset case is skipped at line616; passing that
job does not accept this unexecuted actual-provider scenario. Nonblocking recipe observations,
ALM smoke limits and skipped RTC observation integrity remain disclosed; no B01–B06/E3
acceptance follows. Original failed attempts remain preserved.

**Actual UI source refresh:** The maintained exhaustive owner already contains an
actual browser-rallar/Postgres Manual Native application and Signaling draft reload case.
That source coverage is distinct from its runtime acceptance and does not prove Local
run override, unavailable Native refusal or fresh external delivery. Local accepted
recipes live in the runtime store; inspected owners expose route remount restoration,
with no dedicated custom recipe reload store. Do not invent one to satisfy a hypothetical
persistence path. The new Local Native refusal witness uses actual unscoped SDK
construction and the existing typed application-unavailable boundary. Its first exact
maintained run stops before browser execution because DATABASE_URL is absent; an additional
wrapper prerequisite check stops before launch. Both are setup evidence, not semantic RED.
After read-only canonical Postgres verification and process-only prerequisite supply, the
actual second test execution passes1/1 in7.4s. It proves fresh real UI/SDK Native/run refusal,
exact accepted authored Off body, typed sink-unavailable failure and no connect completion.
It does not prove successful Native channel delivery or repeat freshness. Three formatting
hunks follow that refusal pass; no runtime equivalence is claimed from the failed legacy
TypeScript scanner attempt. The unchanged actual Manual Native/export/reload/reset case
then passes1/1 in13.2s at final source. Root verifies all22 frozen bindings. Both passing
logs retain unrelated topology corruption, open outbox circuits and resource/lifecycle
errors from the shared database; no service-health or performance acceptance follows.
Independent review finds no defect in the new refusal. Under complete-owner closure,
the SAME author removes only the redundant static-heading Local smoke; meaningful retained
Load/Run/Reset passes1/1 in16.7s at corrected source, scoped typing/format pass, and
the SAME reviewer closes SPEC/QUALITY with no findings. Root verifies22 frozen/current
bindings, unchanged retained witness bodies and21 unchanged non-spec owners. No production
correction, migration, duplicate policy or artificial RED is released. The separate real
PR645 conflict against parent979 is confined to this plan; source auto-composes. Root
reconciles both plan additions and preserves all continuation evidence and parent facts.
Independent composition review and affected combined-source validation precede publication.

**Published composition failure and receiving-witness limits:** Formation and Medium pass on
the composed published source. Branch broad execution fails exactly the headless boundary:
323.1591796875 Brotli KiB exceeds its 323 KiB packaging allowance. The same focused local
check reproduces the failure. The maintained adjustable strict whole-KiB rule selects 324 KiB,
with all forbidden operator dependencies and other limits preserved. Focused GREEN,
affected headless typecheck/build and independent complete-owner SPEC/QUALITY review pass;
the one-value correction is separately published. Its build retains the existing chunk
warning, and fresh new-head Branch CI remains pending.

The real receiving-browser witness has two preserved setup failures: a Transport selector,
then Local Load correctly rejects an unsupported top-level rtc.send.roomId after receiver
connection. Neither reaches Local Run or proves a transport regression. Root verifies the
canonical schema and removes only invalid test input, with no admission/compatibility change.
The separately frozen valid-roomRef attempt passes1/1 under unchanged timeout and zero
retries. Its source assertions prove the complete authored Off body remains unchanged,
a fresh Native/run/applied receipt, scope-bound actual channel-open, and fresh exact
independent receiving-browser RTC event plus visible payload. Application typing,
focused browser-owner typing and formatting pass; all30 executable input bindings match,
and all earlier cases remain byte-identical. Independent complete-owner SPEC/QUALITY
review approves with no source findings; affected style and coupling checks pass.

Passing preimage/observations body-buffer attachments were not retained by the maintained
list reporter. Preserve actual command/input/exit/log evidence and disclose this limit;
claim no post-hoc raw receipt/native/receiver correlation, capture completeness, repeat,
reliability, performance or E3 result. This is tests-only existing behavior, with no
manufactured semantic RED, production change or selected retention remedy. The original
post-ICE cause remains unknown, and no retry algorithm change is justified here.

**Current source-derived next outcomes:** At the published Local Native checkpoint, the
bounded worker/Actions refresh verifies all25 prior relevant owners unchanged. Generic worker environment, launch, bootstrap and
Configure still omit capture. Actual SDK host defaults read rtc.captureMode, while the
adapter's per-command rtcCaptureMode means step intent; forwarding only that operation
field cannot establish host provenance. Test literal mode and origin through current
actual composition before selecting production forwarding. Preserve absent application
defaults; independently requested capture must apply or report why it could not.

The copied-executable trace preserves complete authored history and child IDs, and fresh
Local runs bypass child-result replay. Raw receiving events identify the transport sender
session but carry no recipe-invocation identity. New event IDs or arrival time alone cannot
attribute an identical-payload same-session repeat. An existing Close/logout/login fixture
could prove a distinct auth-lifecycle path; it does not replace ordinary same-session
repeat acceptance. The existing real realtime.onJson port carries the original native
MessageEvent, so a test-owned observer can associate the literal payload with its native
channel object. The executed public-SDK receiver observes the original Manual native MessageEvent and
channel closure; copied delivery remains unaccepted. Require complete preceding-send
observations, actual old-target closure after Close, a distinct open target for each repeated
receiving effect, and unchanged auth sessions within current budgets. This is not a drain
guarantee.
The Manual browser-rallar provider creates its own facade; loading the UI's public facade
cannot observe that private receiver. An existing public-SDK receiver can supply the owned
port while preserving the actual UI Copy/Load/Run sender; do not claim its private Manual
inbox was observed. Recover this boundary without a new protocol field, placeholder,
freshness discriminator, provider, harness or policy.

Actual UI unavailable-Native refusal and successful Local Native delivery remain accepted
within their stated limits. General-worker host capture is now locally implemented and
published after semantic TDD and independent review, as recorded below. The next two concrete
outcomes are actual Copy/repeat receiving effects across the existing lifecycle, then
worker/Actions propagation and real application. All remaining storage/recipe paths stay required. Recover only existing paths; invent no saved recipe
store or corresponding API, migration or duplicate policy. Publish each coherent
tested/reviewed slice promptly while independent unfinished outcomes remain in progress.

**Local host carrier after semantic TDD:** The original startup-to-SDK RED exposed lost
Off/Signaling/Native host intent and invalid-input Configure/control effects. Separate
no-application HOST coverage closes the original review gap: revised RED has 18 failures
and 11 passes. Sparse-defaults witnesses independently fail on invented application
properties/scope, with two runtime failures and four unsuppressed public-type diagnostics.
Original failures and omission/scoped controls remain preserved.

The implementation carries `RALLAR_BLACK_BOX_RTC_CAPTURE_MODE` through generated query
`rtcCaptureMode`, or matching `VITE_RALLAR_RTC_CAPTURE_MODE`, into nested wire HOST
`rallar.rtc.captureMode` and canonical SDK `rtc.captureMode`. Operation
`rallar.rtcCaptureMode` retains its separate step meaning. One canonical finite parser
owns mode validation; invalid selected input refuses before Configure/control effects,
with sanitized issues, and invalid worker input refuses before browser launch configuration.
Nonempty query wins matching environment, blank query falls back, and omission inherits.

Capture-only settings use the existing single SDK defaults store. Sparse `RallarDefaults`
permits application omission; Setup explicitly retains its required application. No scope
is manufactured, clone preserves omission, and authoritative StateScope/GroupRef/room
contracts remain mandatory. Explicit no-application host capture independently installs
the existing diagnostics ports and applies the requested mode or reports typed inability.
Off retains host origin; omission still installs no application defaults or capture ports.
Existing active/pending receipt ownership and run precedence remain intact. No migration,
mode alias, duplicate policy/provider/store, CRDT edit or transport/retry change is selected.

The unchanged RED test inputs now pass 36 focused tests; maintained controls pass 110,
and public API/entry/bundle-boundary checks pass 32. Package/app typing, both consuming
builds and measured browser budgets pass; builds retain their existing chunk warnings.
The wider tests-project compiler still exits 1 with the exact same 27 outside-owner
diagnostic headers and no changed-test diagnostics. These are local fixture/compile/build
results: no live launched-worker, Actions capture execution, real native attachment,
distributed cohort, B01–B06 or E3 acceptance follows. Full owner review and prompt
publication govern this coherent slice; the next behavioral witness remains actual
Manual Copy and ordinary same-session repeat with unchanged payload and observed
native receive-target retirement, as specified above.

**Hosted acceptance of the published Local Native checkpoint:** Branch Release Gate,
Formation and Medium attempt1 are completed/success, including the optional ALM smoke.
Original archives and the complete validation-evidence-v2 receipt establish fresh broad
validation with reuse=false against the exact published tree. The configured recipe matrix
has101 passing child runs, with its observed/nonblocking and preflight skips preserved.
Main unit counts are14,047 passed/12 skipped; app-browser counts are48 passed/69 skipped.
The hosted app suite explicitly skips the actual Full native receiving-browser, unavailable
capture and Manual capture/export/reload/reset cases. Their local acceptance cannot be
inferred from this gate. This evidence does not certify the later worker carrier, distributed
capture forwarding, B01–B06, E3 or a performance baseline.

**Current worker/Actions acceptance gaps:** The next-outcome audit is bound to the published
worker carrier and all 67 inspected source/context owners. Controller09's optional env
allowlist omits `RALLAR_BLACK_BOX_RTC_CAPTURE_MODE`; general manual/reusable/GitHub-free
workflows and dispatch/world-fleet helpers have no executable finite operator RUN choice.
The existing manifest `rtcCaptureMode` remains the canonical run carrier; HOST and RUN
must retain their separate ownership and actual SDK receipt origins.

The original pure `toEffectiveHetznerRunManifestScope` reproduction changed capture
literal `off` at manifest, recipe, operation and nested HOST fields into the effective
room ID. That invocation/output remains preserved as fragment evidence. Subsequent
complete schema-valid materializer REDs witnessed all four carriers; the reviewed structural
scope correction now preserves them, unrelated data and admitted request forms. Its focused
validation and owned-process cleanup are accepted at the checkpoint above. The remaining
worker/Actions TDD must witness their actual HOST/RUN forwarding and SDK application,
including command/receipt ownership; the earlier fragment does not supply that proof.
Worker registration alone, a selected input, an applied native receipt or absent log rows
cannot prove native channel attachment, delivery or Off allocation behavior.

**Hosted acceptance of the published worker carrier:** Fresh original-attempt
Branch37714910111, Formation37714909898 and Medium37714909915 succeed. Eight original
archive digests and the validation-evidence-v2 receipt bind head46de; the actual synthetic
merge ed0eaa5b has parents979/46de and the reviewed tree939c2. Actual reuse=false telemetry
is retained. The hosted app suite skips actual Native delivery, unavailable capture and
Manual capture/export/reload/reset; RTC integrity is skipped. These correctness gates do
not supply real worker/Actions capture, native attachment, distributed, B01–B06 or E3 evidence.

Full Task65, Console, existing Load/Copy/storage/restore/repeat outcomes, workers, Actions
and B01–B06/E3 remain required. No retry, recovery, CRDT or RTC transport behavior changes.

## 12. Baseline Completion Gate

This plan is complete only when required B01-B06 evidence is finalized,
verified, and recoverably retained; every required B01-B06 primary and every
controller-required repeat passes correctness, sample, and cohort acceptance;
every warmup/retained attempt and cohort is accounted without mutation,
overwrite, or silent discard; selected metrics satisfy noise/comparison rules;
all provenance/configuration/units/raw hashes and limitations reconcile; and
conditional E4 primary and every required repeat satisfy the same successful
acceptance whenever the exact candidate requires that environment.

An unavailable, failed, or unexecuted required workload remains incomplete.
Retaining and verifying its failed artifact preserves evidence but does not
satisfy completion.

The human then accepts one separately scoped follow-up or the explicit outcome
`no optimization justified`. Continuing E2/E3 observation streams do not need a
final main snapshot. B07 is outside default completion unless separately added
or required for a distributed claim. Use current ordinary PR delivery, not a
new activation record, shared catalog, progress ledger, or post-merge task.
Delete this plan in the completing PR only when its accepted outcomes are met,
as current repository guidance requires; the present refresh does not complete it.
