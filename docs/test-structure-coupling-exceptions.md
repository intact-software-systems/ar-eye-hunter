# Test structure-coupling exception registry

`npm run check:test-structure-coupling` is a full-tree advisory review aid. It detects
tests coupled to production source text, file topology, ASTs, symbol spelling,
source hashes or snapshots, line counts, call/import order, and migration or
compatibility topology. A clean report does not prove that every test is
semantic; a candidate is a prompt for human review, not an automatic failure.

Production code remains the primary design artifact. Delete or replace an
incidental structural test with semantic coverage when production design
improves. Retain one only when it protects an independently stated durable
public, security, or compatibility boundary, or when it is a temporary ratchet
with a named owner and removal condition. Do not use this registry as a blanket
baseline or automatic grandfathering mechanism.

The `contracts` section states each independently meaningful domain contract
in human language and links it to the exact executable assertion that proves
the boundary. The assertion may share a file with a candidate only when it
executes the named behavior and the candidate is a concrete input to that
behavior; merely naming the same structural file is not coverage. Each entry
links one exact occurrence to one contract. Its `id`, `path`, `line`, `column`,
and `kind` must match the checker report exactly, while its rationale explains
why that occurrence is needed by that assertion. Related occurrences share a
contract; distinct executable assertions remain separately reviewable.

Every entry has a named `owner`. A `durable-boundary` entry additionally
declares `boundary` as `public`, `security`, or `compatibility`. A
`temporary-ratchet` entry additionally declares an assertion-specific
`removalCondition`. Placeholder, escaped control-only, or vague values such as
`TODO`, `none`, `later`, `...`, `-`, `semantic coverage`, or bracketed
placeholders are not valid evidence. A contract with no current candidates is
also invalid, so this document cannot accumulate orphan approvals.

## Reviewed boundary groups

The current 127 entries were reviewed by independently meaningful behavior,
not by vocabulary. The metadata below splits these groups further by exact
executable assertion so a broad domain label cannot conceal unrelated evidence.

| Group                                            | Entries | Why structural evidence remains                                                                                  |
| ------------------------------------------------ | ------: | ---------------------------------------------------------------------------------------------------------------- |
| Source-analysis interface                        |       1 | One parser owner supplies normalized, path-aware analysis to repository tests.                                   |
| Hetzner workflow and Deno runtime                |       9 | Executed operations are compared with their emitted artifacts, manifests, and deployed config.                   |
| Browser control protocol                         |       7 | Two approved assertions protect server import direction and shared-test monitor ownership.                       |
| Auth compatibility                               |       3 | Wrapper mutations and the canonical-test inventory protect distinct compatibility edges.                         |
| Repository style and release interfaces          |       2 | Automation consumes stable rule and release-gate mappings.                                                       |
| AppInbox transport routing                       |      14 | Concrete route and command-binding mutations must fail before they bypass the canonical transaction owner.       |
| Mutation-analysis implementation interface       |       3 | The audit must follow new files, re-exports, and type declarations fail-closed.                                  |
| Mutation route and owner traversal               |      13 | Route, export, helper, and capability evasions must still resolve to AppInbox.                                   |
| Group mutation construction                      |      14 | Missing, duplicate, reordered, conditional, or rebound owner calls must be rejected.                             |
| Group HTTP mutation shapes                       |      17 | Malformed commands, results, registrations, translators, and unreachable handoffs must be rejected.              |
| Mutation registration collections and predicates |      12 | Live handler families and exact predicates must remain complete and authoritative.                               |
| API-v1 recipe loading and routing                |       4 | Checked-in recipes and runner plans are executable public test interfaces.                                       |
| State-read convergence recipes                   |       2 | Parsed fixtures carry run-scoped identity and tertiary causal evidence.                                          |
| Black-box schema and recipe matrix               |      10 | Published fixtures, examples, compatibility corpus, evidence tiers, and catalog promises are validated directly. |
| State-write recipe evidence                      |       5 | Parsed command/evidence pairs prove digests, revisions, effects, and execution identity.                         |
| Shared-web package boundaries                    |       9 | Consumer imports, browser bundles, and entrypoint inventories enforce package direction.                         |
| Shared RTC benchmark navigation                  |       9 | Package navigation, accepted-evidence exclusion, and Deno-check participation are published package interfaces.  |
| Group topology canonical import direction        |       6 | Active composition and package exports bypass compatibility-only predecessor paths.                              |

The full current candidate tree validates this registry even when the command
reports a selected file set or a Git range. Filtered modes change the report,
not which registrations must remain current. The detector associates source
structure assertions with production-source values in the same bounded test
block; unrelated JSON, artifact, filesystem, or compatibility text is not a
candidate. The checker rejects duplicate, stale, or incomplete registrations,
while unregistered full-tree candidates remain advisory until they are reviewed
individually. The `--changed <base> <head>` mode fails closed for every current
changed occurrence without an individual disposition; deleted occurrences stay
neutral evidence.

Candidate IDs are intentionally location-specific so every occurrence receives
its own review and an edited assertion cannot silently inherit another
assertion's exception. In a changed range, the checker compares a rename or
modification's old and new occurrences by kind and normalized syntax detail:
unmatched old occurrences are neutral `change=deleted` evidence, never a
semantic replacement. Copies report `origin=copy`. A file move can therefore
require an explicit registry update after its new candidate IDs are reviewed;
range matching is reporting evidence only and never transfers approval to a
moved or changed test.

```test-structure-coupling-registry-v1
{
  "version": 1,
  "contracts": [
    {
      "id": "api-v1-medium-scale-routing",
      "domain": "API-v1 medium-scale recipe routing",
      "owner": "Rallar server maintainers",
      "summary": "Each group poll targets the API node whose clustered convergence it proves. Executable assertion: “names every group poll for the API node that executes it”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts#names every group poll for the API node that executes it",
      "coverageRelation": "The recipe semantics suite executes the clustered profile and verifies tertiary service requirements; this fixture read ties each named poll to the API node whose convergence it proves."
    },
    {
      "id": "api-v1-recipe-fixture-interface",
      "domain": "API-v1 recipe fixture loading",
      "owner": "Rallar server maintainers",
      "summary": "Shared recipe tests load executable YAML fixtures through one repository-root-aware interface. Executable assertion: “defines a no-browser three-server topology convergence recipe”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe",
      "coverageRelation": "The three-server recipe suite executes parsed YAML through the shared fixture loader; these reads are the repository-root and fixture-text inputs to that public test interface."
    },
    {
      "id": "api-v1-runner-plan-interface",
      "domain": "API-v1 runner plan interface",
      "owner": "Rallar server maintainers",
      "summary": "Managed Postgres commands expose three API nodes and select complete recipe plans without hidden side effects. Executable assertion: “starts three API servers for every managed Postgres cluster command”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts#starts three API servers for every managed Postgres cluster command",
      "coverageRelation": "The runner-plan suite executes managed Postgres planning and asserts all three server processes; this manifest read supplies the actual package command selected by that plan."
    },
    {
      "id": "auth-server-wrapper-mutation-boundary",
      "domain": "Auth compatibility wrapper directness",
      "owner": "Rallar repository maintainers",
      "summary": "Retained auth wrappers preserve export kind, canonical target, and directness. Executable assertion: “rejects export kind, target, and second-hop changes”.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-governance.test.ts#rejects export kind, target, and second-hop changes",
      "coverageRelation": "The mutation assertion rewrites each approved wrapper shape and must reject a type/runtime export swap, a different canonical target, and a second compatibility hop. Runtime identity alone cannot detect type-only drift or an extra indirection that currently resolves to the same value."
    },
    {
      "id": "auth-server-canonical-test-inventory",
      "domain": "Canonical auth test import boundary",
      "owner": "Rallar repository maintainers",
      "summary": "Canonical auth tests import canonical owners rather than compatibility wrappers. Executable assertion: “keeps every canonical auth test free of compatibility wrappers”.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-governance.test.ts#keeps every canonical auth test free of compatibility wrappers",
      "coverageRelation": "The assertion enumerates every canonical auth test and checks its imports against the wrapper ledger. Running the auth behavior suite cannot prove that a newly added test did not start depending on a deprecated compatibility path."
    },
    {
      "id": "black-box-schema-public-interface--keeps-schema-compatibility-guide-json-examples-validating",
      "domain": "Shared black-box schema interface",
      "owner": "Shared Test maintainers",
      "summary": "Recipe fixtures, examples, compatibility corpus, and application RTC examples validate against the published schema. Executable assertion: “keeps schema compatibility guide JSON examples validating”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps schema compatibility guide JSON examples validating",
      "coverageRelation": "The named schema test parses and validates the exact published fixture, application example, compatibility corpus, or guide example represented by this filesystem occurrence."
    },
    {
      "id": "black-box-schema-public-interface--keeps-the-app-local-rtc-example-self-contained-for-headless-brow",
      "domain": "Shared black-box schema interface",
      "owner": "Shared Test maintainers",
      "summary": "Recipe fixtures, examples, compatibility corpus, and application RTC examples validate against the published schema. Executable assertion: “keeps the app-local RTC example self-contained for headless browser agents”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps the app-local RTC example self-contained for headless browser agents",
      "coverageRelation": "The named schema test parses and validates the exact published fixture, application example, compatibility corpus, or guide example represented by this filesystem occurrence."
    },
    {
      "id": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "domain": "Shared black-box schema interface",
      "owner": "Shared Test maintainers",
      "summary": "Recipe fixtures, examples, compatibility corpus, and application RTC examples validate against the published schema. Executable assertion: “validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets",
      "coverageRelation": "The named schema test parses and validates the exact published fixture, application example, compatibility corpus, or guide example represented by this filesystem occurrence."
    },
    {
      "id": "control-protocol-server-import-direction",
      "domain": "Control-server protocol import direction",
      "owner": "Shared Test maintainers",
      "summary": "The control server cannot import the SPA-owned protocol module. Executable assertion: “does not import control protocol from the SPA app into the control server”.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server",
      "coverageRelation": "This approved architecture assertion enumerates the control-server source and rejects the forbidden SPA protocol import. Runtime protocol behavior cannot reveal an app-local fork or a reversed server-to-SPA dependency when both copies still behave alike."
    },
    {
      "id": "control-protocol-browser-boundary",
      "domain": "Distributed monitor production ownership",
      "owner": "Shared Test maintainers",
      "summary": "The SPA delegates distributed monitor, analysis, and verdict derivation to shared-test. Executable assertion: “keeps distributed run monitor derivation in shared-test instead of the SPA app”.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app",
      "coverageRelation": "This approved package-boundary assertion inspects the SPA integration module for its canonical shared-test import and absence of three local derivations. Rendered monitor behavior cannot distinguish delegation from a behaviorally identical app-local duplicate."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-conditional-private-owner-call-in-the-exported-family-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a conditional private-owner call in the exported family registrar”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-after-the-handler-return",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only after the handler return”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only after the handler return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-a-literal-false-handler-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only in a literal-false handler branch”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in a literal-false handler branch",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-an-uninvoked-nested-hand",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only in an uninvoked nested handler function”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-duplicate-private-owner-call-in-the-exported-family-re",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a duplicate private-owner call in the exported family registrar”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a duplicate private-owner call in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-private-owner-call-after-a-family-registrar-return",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a private-owner call after a family-registrar return”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-removed-private-owner-call-from-the-exported-family-re",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a removed private-owner call from the exported family registrar”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-second-exact-registration-in-the-exported-family-regis",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a second exact registration in the exported family registrar”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a second exact registration in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-separately-bound-command-declared-after-its-submission",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a separately bound command declared after its submission”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-computed-result-object-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an AppInbox type overridden by a computed result-object property”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a computed result-object property",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-later-result-object-spr",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an AppInbox type overridden by a later result-object spread”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-exact-registration-after-an-unconditional-owner-retur",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an exact registration after an unconditional owner return”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration after an unconditional owner return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-exact-registration-inside-a-literal-false-owner-branc",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an exact registration inside a literal-false owner branch”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration inside a literal-false owner branch",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-computed-command-object-pro",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an operation overridden by a computed command-object property”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a computed command-object property",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-later-command-object-spread",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an operation overridden by a later command-object spread”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a later command-object spread",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-duplicate-direct-appinbox-type-properties-in-the-result-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects duplicate direct AppInbox type properties in the result object”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct AppInbox type properties in the result object",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-duplicate-direct-operation-properties-in-the-command-obj",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects duplicate direct operation properties in the command object”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct operation properties in the command object",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a canonical family name rebound to a different imported family”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a canonical family name rebound to a different imported family",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a conditional family call in the exported root”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a conditional family call in the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a different app passed from a family to its private owner”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a different app passed from a family to its private owner",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a duplicate family call in the exported root”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call after an exported-root return”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family call after an exported-root return",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-call-before-authorization-exists",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call before authorization exists”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family call before authorization exists",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family removed from the exported root”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family removed from the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a missing family-to-private-owner argument”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an extra family-to-private-owner argument”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an extra root-to-family argument”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an uninventoryed live private owner and route in a family”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects reordered family-to-private-owner arguments”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects reordered family-to-private-owner arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects reordered root-to-family arguments”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects wrong root-to-family arguments”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects wrong root-to-family arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "hetzner-control-deno-runtime",
      "domain": "Hetzner control-server Deno runtime",
      "owner": "Rallar operations maintainers",
      "summary": "Deployment cache warming and systemd startup use the control server owned Deno configuration. Executable assertion: “uses the control-server Deno config for Hetzner cache warming and systemd start”.",
      "semanticCoverage": "packages/tests/hetzner/spa-env-script.test.ts#uses the control-server Deno config for Hetzner cache warming and systemd start",
      "coverageRelation": "The named deployment test executes the SPA environment script and verifies that cache warming and service startup resolve the control server configuration actually shipped to Hetzner."
    },
    {
      "id": "hetzner-distributed-workflow--keeps-playwright-packages-aligned-past-the-node-24-browser-insta",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “keeps Playwright packages aligned past the Node 24 browser-install hang regression”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#keeps Playwright packages aligned past the Node 24 browser-install hang regression",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “materializes a deterministic isolated group throughout executable manifest data”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--persists-control-server-snapshots-with-an-atomic-temp-file-renam",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “persists control-server snapshots with an atomic temp-file rename”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#persists control-server snapshots with an atomic temp-file rename",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--prepares-the-supported-commit-once-before-running-the-serial-man",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “prepares the supported commit once before running the serial manifest matrix”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#prepares the supported commit once before running the serial manifest matrix",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--preserves-a-parallel-label-that-happens-to-equal-the-source-room",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “preserves a parallel label that happens to equal the source room”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#preserves a parallel label that happens to equal the source room",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--rejects-an-executable-command-scoped-outside-the-source-manifest",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “rejects an executable command scoped outside the source manifest group”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#rejects an executable command scoped outside the source manifest group",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "hetzner-distributed-workflow--repairs-known-deno-lockfile-drift-before-the-controlled-rollout-",
      "domain": "Supported Hetzner distributed workflow",
      "owner": "Rallar operations maintainers",
      "summary": "Materialized manifests, rollout guards, artifact publication, and command scope remain executable and deterministic. Executable assertion: “repairs known Deno lockfile drift before the controlled rollout dirty checkout guard”.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#repairs known Deno lockfile drift before the controlled rollout dirty checkout guard",
      "coverageRelation": "The named operations test executes the checked-in workflow or controller helper and asserts its externally visible file, command, or manifest result; the read is evidence produced or consumed by that exact scenario."
    },
    {
      "id": "mutation-boundary-analysis-interface",
      "domain": "Mutation boundary analysis interface",
      "owner": "Rallar server maintainers",
      "summary": "The routing audit follows imports and exported capabilities through one deterministic analysis model. Executable assertion: “exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions",
      "coverageRelation": "The analyzer test executes import traversal and inventory checks across the authoritative mutation surface; this file enumeration is the fail-closed production input to that security audit."
    },
    {
      "id": "mutation-capability-export-interface",
      "domain": "Mutation capability export analysis",
      "owner": "Rallar server maintainers",
      "summary": "Exported mutation capabilities resolve to their canonical implementation owner before routing assertions run. Executable assertion: “resolves mutable repository capabilities through the shared-server barrel”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel",
      "coverageRelation": "The capability traversal test executes barrel and re-export resolution; this AST parse is the mechanism that follows a mutable capability to its canonical owner."
    },
    {
      "id": "package-dependency-direction-import-map",
      "domain": "Package dependency direction",
      "owner": "Rallar platform maintainers",
      "summary": "The api-v1 Deno import map advertises no browser or test-only package to application source. Executable assertion: “keeps the api-v1 Deno import map free of browser and test-only packages”.",
      "semanticCoverage": "packages/tests/repo/package-dependency-direction.test.ts#keeps the api-v1 Deno import map free of browser and test-only packages",
      "coverageRelation": "The import-direction suite executes the layering rule over every package source file; this config read covers the one surface that grants resolution before any import exists."
    },
    {
      "id": "mutation-capability-type-interface",
      "domain": "Mutation capability type analysis",
      "owner": "Rallar server maintainers",
      "summary": "Capability declarations remain distinguishable from executable authoritative mutation owners. Executable assertion: “maps all 54 entrypoints and 50 types to real registrations and owners”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#maps all 54 entrypoints and 50 types to real registrations and owners",
      "coverageRelation": "The route-owner suite executes type-to-owner mapping over the complete inventory; this AST parse distinguishes type declarations from executable mutation owners."
    },
    {
      "id": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “binds direct client registrations to their live types”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#binds direct client registrations to their live types",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--binds-topology-loops-to-their-live-types",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “binds topology loops to their live types”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#binds topology loops to their live types",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-crdt-type-removed-from-its-imported-live-registration-",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a CRDT type removed from its imported live registration collection”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects a CRDT type removed from its imported live registration collection",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects an auth registration loop replaced with an empty iterable”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects an auth registration loop replaced with an empty iterable",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-group-create-removed-from-the-imported-live-group-regist",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects GROUP_CREATE removed from the imported live group registration collection”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects GROUP_CREATE removed from the imported live group registration collection",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “evaluates safe logical includes and identity map chains exactly”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “fails closed for an opaque registration predicate”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate",
      "coverageRelation": "The named test mutates the live group registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the auth registration array with an exact equality filter”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-group-registration-array-with-an-exact-equality-filt",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the group registration array with an exact equality filter”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the group registration array with an exact equality filter",
      "coverageRelation": "The named test mutates the live group registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--rejects-a-group-registration-filter-that-is-always-false",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “rejects a group registration filter that is always false”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#rejects a group registration filter that is always false",
      "coverageRelation": "The named test mutates the live group registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "domain": "Authoritative mutation route ownership",
      "owner": "Rallar server maintainers",
      "summary": "Every authoritative route resolves to one AppInbox transaction owner without a persistence bypass. Executable assertion: “requires the admin mutation gateway and contains no direct-write fallback”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback",
      "coverageRelation": "The named analyzer test executes a concrete route, type, owner, or fallback mutation and requires the security audit to reject it; each source access supplies the exact mutated module or canonical comparison for that scenario."
    },
    {
      "id": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "domain": "Authoritative mutation route ownership",
      "owner": "Rallar server maintainers",
      "summary": "Every authoritative route resolves to one AppInbox transaction owner without a persistence bypass. Executable assertion: “uses one named readonly input object for each authorised websocket enqueue helper”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper",
      "coverageRelation": "The named analyzer test executes a concrete route, type, owner, or fallback mutation and requires the security audit to reject it; each source access supplies the exact mutated module or canonical comparison for that scenario."
    },
    {
      "id": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every example and test recipe is uniquely catalogued with explicit profile, execution mode, and compatibility. Executable assertion: “advertises the API-v1 profile in recipe-matrix CLI usage”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage",
      "coverageRelation": "The named matrix test loads the published catalog or referenced recipe and asserts the exact uniqueness, coverage, compatibility, or CLI promise represented by this occurrence."
    },
    {
      "id": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every API-v1 recipe declares whether it is a Tier 1 public-interface test or a Tier 2 durability proof that reads SQL evidence. Executable assertion: “labels every api-v1 entry with an honest evidence tier”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier",
      "coverageRelation": "The named matrix test compares each published tier with the concrete SQL-evidence operator used by its shipped recipe. Executing the recipe can prove its assertions but cannot reveal whether the evidence came from the public API or the database, so the static operator classification is part of the operator-facing catalog contract."
    },
    {
      "id": "recipe-matrix-public-interface--points-every-entry-at-a-catalog-recipe-file",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every example and test recipe is uniquely catalogued with explicit profile, execution mode, and compatibility. Executable assertion: “points every entry at a catalog recipe file”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#points every entry at a catalog recipe file",
      "coverageRelation": "The named matrix test loads the published catalog or referenced recipe and asserts the exact uniqueness, coverage, compatibility, or CLI promise represented by this occurrence."
    },
    {
      "id": "recipe-matrix-public-interface--uses-rallar-signaling-for-signaling-recipe-examples-and-keeps-on",
      "domain": "Supported recipe matrix",
      "owner": "Shared Test maintainers",
      "summary": "Every example and test recipe is uniquely catalogued with explicit profile, execution mode, and compatibility. Executable assertion: “uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture”.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture",
      "coverageRelation": "The named matrix test loads the published catalog or referenced recipe and asserts the exact uniqueness, coverage, compatibility, or CLI promise represented by this occurrence."
    },
    {
      "id": "repo-style-checker-interface",
      "domain": "Repository style checker interface",
      "owner": "Rallar repository maintainers",
      "summary": "Every governed Deno configuration inherits the canonical TypeScript formatter settings. Executable assertion: “keeps TypeScript formatter settings aligned with the canonical baseline”.",
      "semanticCoverage": "packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline",
      "coverageRelation": "The assertion reads each governed Deno config and compares its formatter object with the canonical baseline. Formatting one sample file cannot prove that every repository formatter entrypoint uses the same settings."
    },
    {
      "id": "shared-web-app-import-boundary",
      "domain": "Shared-web application import boundary",
      "owner": "Shared Web maintainers",
      "summary": "Reusable browser modules never import application-owned code or reverse the intended package direction. Executable assertion: “keeps Relic on its runtime adapter boundary without the broad shared-web barrel”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel",
      "coverageRelation": "The named application-boundary test parses the consumer imports and proves that application code depends on the intended narrow package surface without reversing ownership."
    },
    {
      "id": "shared-web-browser-bundle-boundary",
      "domain": "Shared-web browser bundle boundary",
      "owner": "Shared Web maintainers",
      "summary": "Browser entrypoints remain free of server-only dependencies when bundled for application consumers. Executable assertion: “keeps shared-web from declaring graphology directly”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts#keeps shared-web from declaring graphology directly",
      "coverageRelation": "The browser bundle suite builds the narrow entrypoints and checks their dependency graph and size; this manifest read establishes the package dependency declaration used by that executable bundle check."
    },
    {
      "id": "shared-web-browser-entrypoints--keeps-capability-controllers-behind-injected-ports",
      "domain": "Shared-web public browser entrypoints",
      "owner": "Shared Web maintainers",
      "summary": "Published browser entrypoints expose the intended files and remain importable by consumers. Executable assertion: “keeps capability controllers behind injected ports”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps capability controllers behind injected ports",
      "coverageRelation": "The named entrypoint test imports or analyzes the published browser surface and requires the exact internal module inventory represented by this occurrence to remain behind its injected port or public owner."
    },
    {
      "id": "shared-web-browser-entrypoints--keeps-mutable-state-cache-access-inside-the-state-store",
      "domain": "Shared-web public browser entrypoints",
      "owner": "Shared Web maintainers",
      "summary": "Published browser entrypoints expose the intended files and remain importable by consumers. Executable assertion: “keeps mutable state-cache access inside the state store”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps mutable state-cache access inside the state store",
      "coverageRelation": "The named entrypoint test imports or analyzes the published browser surface and requires the exact internal module inventory represented by this occurrence to remain behind its injected port or public owner."
    },
    {
      "id": "shared-web-browser-entrypoints--keeps-runtime-controllers-independent-from-the-aggregate-contrac",
      "domain": "Shared-web public browser entrypoints",
      "owner": "Shared Web maintainers",
      "summary": "Published browser entrypoints expose the intended files and remain importable by consumers. Executable assertion: “keeps runtime controllers independent from the aggregate contract”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps runtime controllers independent from the aggregate contract",
      "coverageRelation": "The named entrypoint test imports or analyzes the published browser surface and requires the exact internal module inventory represented by this occurrence to remain behind its injected port or public owner."
    },
    {
      "id": "shared-web-browser-entrypoints--keeps-runtime-controllers-independent-from-the-compatibility-ent",
      "domain": "Shared-web public browser entrypoints",
      "owner": "Shared Web maintainers",
      "summary": "Published browser entrypoints expose the intended files and remain importable by consumers. Executable assertion: “keeps runtime controllers independent from the compatibility entrypoint”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps runtime controllers independent from the compatibility entrypoint",
      "coverageRelation": "The named entrypoint test imports or analyzes the published browser surface and requires the exact internal module inventory represented by this occurrence to remain behind its injected port or public owner."
    },
    {
      "id": "shared-web-browser-entrypoints--limits-the-full-runtime-context-to-the-composer-and-port-contrac",
      "domain": "Shared-web public browser entrypoints",
      "owner": "Shared Web maintainers",
      "summary": "Published browser entrypoints expose the intended files and remain importable by consumers. Executable assertion: “limits the full runtime context to the composer and port contracts”.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#limits the full runtime context to the composer and port contracts",
      "coverageRelation": "The named entrypoint test imports or analyzes the published browser surface and requires the exact internal module inventory represented by this occurrence to remain behind its injected port or public owner."
    },
    {
      "id": "source-analysis-test-interface",
      "domain": "Repository source-analysis test interface",
      "owner": "Rallar repository maintainers",
      "summary": "Test suites parse tracked TypeScript through one deterministic, path-aware analysis interface. Executable assertion: “normalizes TypeScript and TSX module syntax without exposing parser nodes”.",
      "semanticCoverage": "packages/tests/helpers/source-analysis.test.ts#normalizes TypeScript and TSX module syntax without exposing parser nodes",
      "coverageRelation": "The helper unit suite executes parsing, normalization, resolution, graph traversal, and path-aware failures; this AST access is the implementation input for that repository test interface."
    },
    {
      "id": "state-read-convergence-recipe--defines-run-scoped-identifiers-as-interpolated-string-values",
      "domain": "Clustered state-read convergence recipe",
      "owner": "Rallar server maintainers",
      "summary": "The recipe proves tertiary scalar and causal floors with source headers and run-scoped identities. Executable assertion: “defines run-scoped identifiers as interpolated string values”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#defines run-scoped identifiers as interpolated string values",
      "coverageRelation": "The named recipe test executes the parsed convergence fixture and asserts the run-scoped identity or tertiary causal evidence represented by this read."
    },
    {
      "id": "state-read-convergence-recipe--proves-tertiary-scalar-and-causal-floors-with-revision-and-sourc",
      "domain": "Clustered state-read convergence recipe",
      "owner": "Rallar server maintainers",
      "summary": "The recipe proves tertiary scalar and causal floors with source headers and run-scoped identities. Executable assertion: “proves tertiary scalar and causal floors with revision and source headers”.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#proves tertiary scalar and causal floors with revision and source headers",
      "coverageRelation": "The named recipe test executes the parsed convergence fixture and asserts the run-scoped identity or tertiary causal evidence represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--executes-the-topology-exact-revision-assertions-before-every-cle",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “executes the topology exact-revision assertions before every cleanup step”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#executes the topology exact-revision assertions before every cleanup step",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--forbids-literal-set-values-from-claiming-durable-state-write-evi",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “forbids literal SET values from claiming durable state-write evidence”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#forbids literal SET values from claiming durable state-write evidence",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--observes-committed-socket-authorization-before-clustered-ws-effe",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “observes committed socket authorization before clustered WS effects”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#observes committed socket authorization before clustered WS effects",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--selects-auth-ticket-races-by-the-redacted-secret-and-exact-durab",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “selects auth ticket races by the redacted secret and exact durable digest”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects auth ticket races by the redacted secret and exact durable digest",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "state-write-recipe-evidence--uses-one-bounded-execution-identity-for-the-command-and-its-evid",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "State-write recipes bind command, durable result, and post-commit effects to one bounded execution identity. Executable assertion: “uses one bounded execution identity for the command and its evidence”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#uses one bounded execution identity for the command and its evidence",
      "coverageRelation": "The named recipe test executes parsed public commands and assertions, then verifies the exact durable digest, revision, post-commit effect, or bounded execution identity represented by this read."
    },
    {
      "id": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "domain": "Shared RTC benchmark package navigation",
      "owner": "Shared RTC benchmark maintainers",
      "summary": "The private benchmark package publishes one durable navigation row per executable, names exact command, setup, measured-operation, and timing facts, and participates in root test discovery. Executable assertion: “documents each executable exactly once and discovers package tests”.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests",
      "coverageRelation": "The architecture assertion compares the approved executable inventory with the shipped package README, locks the exact baseline grammar and code-derived setup, measured-operation, and timing claims, and independently verifies root Vitest discovery for the package test tree."
    },
    {
      "id": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "domain": "Shared RTC benchmark diagnostic navigation",
      "owner": "Shared RTC benchmark maintainers",
      "summary": "Maintained diagnostics remain outside accepted baseline evidence while every diagnostic participates in package Deno checking. Executable assertion: “keeps diagnostics outside accepted baseline catalog and checked by Deno”.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno",
      "coverageRelation": "The architecture assertion reads the accepted workload catalog and package check command, then proves each maintained diagnostic is excluded from accepted evidence and included in Deno checking."
    },
    {
      "id": "group-topology-canonical-import-direction",
      "domain": "Group topology canonical import direction",
      "owner": "Rallar server maintainers",
      "summary": "Active composition and package exports use canonical topology owners without routing through compatibility-only predecessor paths. Executable assertion: “routes active composition and replay imports directly to canonical topology owners”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners",
      "coverageRelation": "Adjacent runtime identity assertions prove public exports resolve to canonical classes and command functions; this bounded source check covers the separate composition/import-direction promise that runtime identity cannot distinguish from a wrapper hop."
    },
    {
      "id": "typescript-seven-release-boundary",
      "domain": "TypeScript 7 release boundary",
      "owner": "Rallar repository maintainers",
      "summary": "Release automation checks pinned TypeScript workspaces separately from Deno-owned applications. Executable assertion: “keeps TypeScript and Deno checking as separate release gates”.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates",
      "coverageRelation": "The release-boundary test executes the manifest/workflow inspection that keeps npm TypeScript checking separate from Deno checking; this workflow read is its exact release interface."
    }
  ],
  "entries": [
    {
      "id": "test-structure-coupling-261ca31da4a525f9",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 42,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-group-registration-array-with-an-exact-equality-filt",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live group registration expression that the test narrows before executing the analyzer and requiring the omitted owner family to fail closed.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the group registration array with an exact equality filter"
    },
    {
      "id": "test-structure-coupling-77029888ca1be290",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 57,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--rejects-a-group-registration-filter-that-is-always-false",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live group registration predicate that the test replaces with false before executing the analyzer and requiring all group owner connections to disappear.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#rejects a group registration filter that is always false"
    },
    {
      "id": "test-structure-coupling-d58d4cea2ca6784a",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 72,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration loop that the test narrows before executing the analyzer and requiring an excluded auth command to lose its owner connection.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter"
    },
    {
      "id": "test-structure-coupling-6229b79ae3b7dbee",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 88,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live group registration predicate that the test makes opaque before executing the analyzer and requiring unknown registration semantics to fail closed.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate"
    },
    {
      "id": "test-structure-coupling-949f17842a0dbcc1",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 104,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration loop that the test replaces with a transparent filter/map chain before executing exact owner-coverage assertions.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly"
    },
    {
      "id": "test-structure-coupling-fd50e2c7deef39e6",
      "path": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts",
      "line": 52,
      "column": 26,
      "kind": "production-source-read",
      "contract": "group-topology-canonical-import-direction",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the package entry whose adjacent runtime assertions require public topology exports to resolve to the canonical owners.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners"
    },
    {
      "id": "test-structure-coupling-f618a827c45f29a6",
      "path": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts",
      "line": 53,
      "column": 28,
      "kind": "production-source-read",
      "contract": "group-topology-canonical-import-direction",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the API composition root to distinguish a direct canonical dependency from a compatibility wrapper with the same runtime export identity.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners"
    },
    {
      "id": "test-structure-coupling-b32d4e1574f65ec9",
      "path": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts",
      "line": 58,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "group-topology-canonical-import-direction",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Pins the package repository export to its canonical implementation path, paired with the adjacent runtime constructor-identity assertion.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners"
    },
    {
      "id": "test-structure-coupling-a0b4058dbfe2f399",
      "path": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts",
      "line": 61,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "group-topology-canonical-import-direction",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Pins the package management export to its canonical implementation path, paired with the adjacent runtime constructor-identity assertion.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners"
    },
    {
      "id": "test-structure-coupling-71da58060c73ca4f",
      "path": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts",
      "line": 64,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "group-topology-canonical-import-direction",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Requires the active API composition root to import the canonical topology management owner directly rather than traverse a predecessor wrapper.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners"
    },
    {
      "id": "test-structure-coupling-585c2caa538c200a",
      "path": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts",
      "line": 70,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "group-topology-canonical-import-direction",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Requires the replay owner to import the canonical topology broadcast materializer directly instead of a compatibility facade.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/inbox/topology-app-inbox-ownership.test.ts#routes active composition and replay imports directly to canonical topology owners"
    },
    {
      "id": "test-structure-coupling-f903c4487c4113b0",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 107,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-before-authorization-exists",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves family construction ahead of authorization resolution, testing lifecycle order at the root composition boundary.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family call before authorization exists"
    },
    {
      "id": "test-structure-coupling-92d45540fb8d9aa7",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 77,
      "column": 20,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--points-every-entry-at-a-catalog-recipe-file",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Opens the recipe file referenced by each matrix entry, proving catalog paths resolve to shipped executable fixtures.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#points every entry at a catalog recipe file"
    },
    {
      "id": "test-structure-coupling-fb291a422405f9f0",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 154,
      "column": 17,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--forbids-literal-set-values-from-claiming-durable-state-write-evi",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads every state-write recipe selected by the evidence catalog and rejects literal SET payloads that bypass generated durable evidence.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#forbids literal SET values from claiming durable state-write evidence"
    },
    {
      "id": "test-structure-coupling-067cb8f802b52e8f",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 1628,
      "column": 18,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--repairs-known-deno-lockfile-drift-before-the-controlled-rollout-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the rollout workflow order to verify the narrow lockfile repair occurs before the dirty-checkout guard evaluates operator changes.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#repairs known Deno lockfile drift before the controlled rollout dirty checkout guard"
    },
    {
      "id": "test-structure-coupling-460946f4a393acd9",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 78,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-crdt-type-removed-from-its-imported-live-registration-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes one CRDT type from the imported live collection, establishing the exact collection mutation the rejection case evaluates.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects a CRDT type removed from its imported live registration collection"
    },
    {
      "id": "test-structure-coupling-10bbdc381d374820",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 42,
      "column": 35,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--executes-the-topology-exact-revision-assertions-before-every-cle",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Parses the topology state-write recipe and compares exact-revision assertion positions with each cleanup command.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#executes the topology exact-revision assertions before every cleanup step"
    },
    {
      "id": "test-structure-coupling-10cf089f85a7c952",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 28,
      "column": 35,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--selects-auth-ticket-races-by-the-redacted-secret-and-exact-durab",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Parses the auth-ticket race recipe so candidate selection is tied to its redacted secret and computed durable digest together.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects auth ticket races by the redacted secret and exact durable digest"
    },
    {
      "id": "test-structure-coupling-d145ea74b1cd174e",
      "path": "packages/tests/shared-server/mutation-boundary-capability-types.ts",
      "line": 235,
      "column": 5,
      "kind": "ast-inspection",
      "contract": "mutation-capability-type-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Inspects the canonical capability declarations so every inventoried mutation type can be joined to an actual registration and owner.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#maps all 54 entrypoints and 50 types to real registrations and owners"
    },
    {
      "id": "test-structure-coupling-f5689a4960545ce1",
      "path": "packages/tests/repo/package-dependency-direction.test.ts",
      "line": 104,
      "column": 18,
      "kind": "production-source-read",
      "contract": "package-dependency-direction-import-map",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar platform maintainers",
      "rationale": "Reads the api-v1 Deno import map so a browser or test-only mapping cannot be reintroduced ahead of any import that would use it.",
      "semanticCoverage": "packages/tests/repo/package-dependency-direction.test.ts#keeps the api-v1 Deno import map free of browser and test-only packages"
    },
    {
      "id": "test-structure-coupling-14caa2363e36d34f",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 851,
      "column": 41,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--prepares-the-supported-commit-once-before-running-the-serial-man",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the workflow job steps to establish that checkout preparation precedes, and is not repeated inside, each serial manifest execution.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#prepares the supported commit once before running the serial manifest matrix"
    },
    {
      "id": "test-structure-coupling-1abb2ef732f76844",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 33,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Opens the SPA distributed-recipes integration module, the single consumer in which a local monitor fork could otherwise hide.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-ddde1657cf06b0cb",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 34,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Introduces a working private owner and route that are absent from the canonical inventory, ensuring live but unnamed mutation paths remain rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family"
    },
    {
      "id": "test-structure-coupling-eeb16118adbc7e35",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 417,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Requires the recipe-matrix CLI source to name api-v1-black-box in its usage output, protecting the operator-visible profile selector.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-26a2619e3f022bb5",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 41,
      "column": 12,
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Requires the authorised websocket helper to accept its first named readonly input object rather than a positional mutation tuple.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-2796354ab33d39ff",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "line": 41,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Requires the Relic runtime module to import its narrow browser adapter, recording the consumer-to-adapter dependency edge.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-293db0169596f3fd",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 62,
      "column": 7,
      "kind": "symbol-assertion",
      "contract": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Checks each forbidden direct-write fragment against AdminOperations, covering the concrete fallback statements that could bypass the gateway.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-298a1cf1247b90cc",
      "path": "packages/tests/shared-server/mutation-boundary-capability-exports.ts",
      "line": 26,
      "column": 19,
      "kind": "ast-inspection",
      "contract": "mutation-capability-export-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the shared-server barrel as the starting export graph, proving mutable capabilities remain traceable through the package public surface.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel"
    },
    {
      "id": "test-structure-coupling-35de774f05b8bf97",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 116,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Mutates the family-to-owner call to pass a different app object, isolating instance continuity across the private ownership boundary.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a different app passed from a family to its private owner"
    },
    {
      "id": "test-structure-coupling-2bd38b2e53d0f490",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 172,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-exact-registration-inside-a-literal-false-owner-branc",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Nests exact registration under a literal-false owner branch, testing reachability of the public route installation.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration inside a literal-false owner branch"
    },
    {
      "id": "test-structure-coupling-34020b59d4e23865",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 32,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Requires the shared-test distributed-run-monitor import, establishing delegation to the package owner rather than copied analysis logic.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-3755f294155bc847",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 54,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Forbids a truthiness guard around mutationGateway, because optional control flow would reopen the direct-write path.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-3c01e239d8d825ab",
      "path": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts",
      "line": 20,
      "column": 13,
      "kind": "production-source-read",
      "contract": "api-v1-runner-plan-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the shared-test package manifest and extracts the real managed Postgres commands whose process plans must contain all three API servers.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts#starts three API servers for every managed Postgres cluster command"
    },
    {
      "id": "test-structure-coupling-41bb14a3f6371988",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 50,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads AdminOperations once as the canonical module on which the required-gateway and no-fallback assertions operate.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-42b8c6cbe01cc04c",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 238,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-separately-bound-command-declared-after-its-submission",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves the separately bound command declaration below AppInbox submission, so the analyzer must reject use before authoritative construction.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission"
    },
    {
      "id": "test-structure-coupling-2a1b652124c26238",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 112,
      "column": 7,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--uses-rallar-signaling-for-signaling-recipe-examples-and-keeps-on",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Loads the designated legacy alias fixture separately so the catalog can require rallar-signaling everywhere else without deleting compatibility evidence.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture"
    },
    {
      "id": "test-structure-coupling-c05b59e36fc5cfbf",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 257,
      "column": 26,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads each catalogued API-v1 recipe as shipped so its declared evidence tier is checked against the evidence source the runner will actually execute.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier"
    },
    {
      "id": "test-structure-coupling-78069c4664e1948b",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 258,
      "column": 31,
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Uses the canonical state-write-evidence recipe operator as the exact Tier 2 discriminator; runtime success alone cannot distinguish a public-API assertion from direct SQL evidence.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier"
    },
    {
      "id": "test-structure-coupling-4b048f6cdfdd5d69",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 52,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Requires the non-optional AdminOperationsMutationGateway field declaration, making gateway ownership explicit in the constructor contract.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-4305e13260503b7c",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 80,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Substitutes a different resolved dependency at the root/family edge, testing provenance rather than just argument count.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects wrong root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-4f5e883227a56d2f",
      "path": "packages/tests/helpers/source-analysis.ts",
      "line": 157,
      "column": 12,
      "kind": "ast-inspection",
      "contract": "source-analysis-test-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads source text at the shared helper boundary and immediately converts it into the normalized path-aware analysis model consumed by repository tests.",
      "semanticCoverage": "packages/tests/helpers/source-analysis.test.ts#normalizes TypeScript and TSX module syntax without exposing parser nodes"
    },
    {
      "id": "test-structure-coupling-4fbc3697b99a488d",
      "path": "packages/tests/repo/repo-code-style-checker-integrity.test.ts",
      "line": 93,
      "column": 20,
      "kind": "production-source-read",
      "contract": "repo-style-checker-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads each enumerated Deno configuration and compares its fmt object with the canonical formatter object consumed by repository automation.",
      "semanticCoverage": "packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline"
    },
    {
      "id": "test-structure-coupling-50ed43bd66d7d0ae",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 189,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-exact-registration-after-an-unconditional-owner-retur",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves the exact route registration below an unconditional owner return, making it dead despite remaining in the source.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration after an unconditional owner return"
    },
    {
      "id": "test-structure-coupling-5415efcebe424618",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 218,
      "column": 30,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-a-literal-false-handler-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Compares the false-branch mutant with the original membership registrar so the assertion proves it tested unreachable rather than canonical source.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in a literal-false handler branch"
    },
    {
      "id": "test-structure-coupling-57415c54fa249a17",
      "path": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts",
      "line": 228,
      "column": 30,
      "kind": "exact-file-tree",
      "contract": "shared-web-browser-entrypoints--keeps-capability-controllers-behind-injected-ports",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Enumerates runtime controller modules and checks each for injected-port use, preventing a newly added controller from escaping the capability boundary.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps capability controllers behind injected ports"
    },
    {
      "id": "test-structure-coupling-5b59037113ffbb08",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 55,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-duplicate-direct-operation-properties-in-the-command-obj",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the command operation key, making the final submitted operation ambiguous to a source-only first-match check.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct operation properties in the command object"
    },
    {
      "id": "test-structure-coupling-5e1fd996ecd7b73c",
      "path": "packages/tests/repo/typescript-7-boundaries.test.ts",
      "line": 187,
      "column": 36,
      "kind": "production-source-read",
      "contract": "typescript-seven-release-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads the shared-test manifest’s TypeScript check command and pairs it with the independently executed Deno workflow gate.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates"
    },
    {
      "id": "test-structure-coupling-1bd68b39317fa044",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 47,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Deletes one canonical family invocation from the root fixture so the analyzer must report the missing owner family.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family removed from the exported root"
    },
    {
      "id": "test-structure-coupling-6092604025a1f16c",
      "path": "packages/tests/hetzner/spa-env-script.test.ts",
      "line": 78,
      "column": 48,
      "kind": "production-source-read",
      "contract": "hetzner-control-deno-runtime",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the deployed control-server Deno config that both cache warming and systemd execute, preventing the host script from validating a different runtime graph.",
      "semanticCoverage": "packages/tests/hetzner/spa-env-script.test.ts#uses the control-server Deno config for Hetzner cache warming and systemd start"
    },
    {
      "id": "test-structure-coupling-6528188e04f724f8",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 24,
      "column": 17,
      "kind": "symbol-assertion",
      "contract": "control-protocol-server-import-direction",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Reads each enumerated control-server module so the assertion covers the whole server import surface, including files added to the approved inventory.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server"
    },
    {
      "id": "test-structure-coupling-fa377a8a33d63f8a",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 17,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the exported root before rebinding a canonical family identifier to another imported registrar, testing binding identity rather than call spelling.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a canonical family name rebound to a different imported family"
    },
    {
      "id": "test-structure-coupling-6abc59a36f1f386c",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 30,
      "column": 24,
      "kind": "production-source-read",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Forbids a local deriveDistributedRunMonitor declaration, which is the primary duplicate implementation this boundary is intended to prevent.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-9b7f0cf6745b5d05",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 85,
      "column": 24,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-crdt-type-removed-from-its-imported-live-registration-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Loads the CRDT owner module alongside the shortened collection so the analyzer must compare registrations with their real owner surface.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects a CRDT type removed from its imported live registration collection"
    },
    {
      "id": "test-structure-coupling-6e60cf6fab59ba61",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 269,
      "column": 32,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Captures the source manifest before group materialization so the assertion can compare the generated execution copy without losing its immutable baseline.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-1fd9fab573bb6f2f",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "line": 37,
      "column": 31,
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--proves-tertiary-scalar-and-causal-floors-with-revision-and-sourc",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Loads the convergence recipe section containing tertiary value, revision, and source-header assertions so those causal floors remain executable data.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#proves tertiary scalar and causal floors with revision and source headers"
    },
    {
      "id": "test-structure-coupling-adae296474840965",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 98,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds a root-owned value to a family invocation beyond its approved signature, testing the public composition tuple exactly.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument"
    },
    {
      "id": "test-structure-coupling-73afd25238ecf179",
      "path": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts",
      "line": 161,
      "column": 30,
      "kind": "exact-file-tree",
      "contract": "shared-web-browser-entrypoints--keeps-runtime-controllers-independent-from-the-aggregate-contrac",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Enumerates runtime controllers and forbids imports from the aggregate contract, preserving their narrower dependency surfaces.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps runtime controllers independent from the aggregate contract"
    },
    {
      "id": "test-structure-coupling-74360f596f2e2553",
      "path": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts",
      "line": 147,
      "column": 30,
      "kind": "exact-file-tree",
      "contract": "shared-web-browser-entrypoints--keeps-runtime-controllers-independent-from-the-compatibility-ent",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Scans the complete runtime-controller inventory for compatibility-entrypoint imports that runtime behavior would not reveal.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps runtime controllers independent from the compatibility entrypoint"
    },
    {
      "id": "test-structure-coupling-74df1f432f7e9a8f",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 15,
      "column": 27,
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads and parses that helper module so parameter declarations are evaluated as syntax, not brittle substring matches.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-d03beed5c5efcd0e",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 97,
      "column": 19,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--binds-topology-loops-to-their-live-types",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Inspects the topology registration loop so the audit evaluates its iterated live type collection rather than only the loop body.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#binds topology loops to their live types"
    },
    {
      "id": "test-structure-coupling-1c6a23dcf6e6e6b0",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 54,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-group-create-removed-from-the-imported-live-group-regist",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Deletes GROUP_CREATE from the imported group type collection and requires the owner audit to report that specific missing live route.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects GROUP_CREATE removed from the imported live group registration collection"
    },
    {
      "id": "test-structure-coupling-37eab7de5df607a3",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 169,
      "column": 35,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--uses-one-bounded-execution-identity-for-the-command-and-its-evid",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the bounded-execution recipe and compares the command identity with the evidence query identity in the same parsed fixture.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#uses one bounded execution identity for the command and its evidence"
    },
    {
      "id": "test-structure-coupling-34419725117cff44",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 130,
      "column": 17,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--observes-committed-socket-authorization-before-clustered-ws-effe",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Loads the socket-authorization recipe to verify its commit observation precedes the clustered websocket effect assertion.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#observes committed socket authorization before clustered WS effects"
    },
    {
      "id": "test-structure-coupling-802f4bf52c03d28e",
      "path": "packages/tests/repo/auth-server-compatibility-governance.test.ts",
      "line": 38,
      "column": 11,
      "kind": "production-source-read",
      "contract": "auth-server-wrapper-mutation-boundary",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "Loads the approved wrapper and changes its direct export kind or canonical target; that mutant proves the ledger rejects compatibility drift at the first hop.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-governance.test.ts#rejects export kind, target, and second-hop changes"
    },
    {
      "id": "test-structure-coupling-82ba58a8bd767596",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 161,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-duplicate-private-owner-call-in-the-exported-family-re",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the private-owner setup inside the family registrar to enforce a single authoritative registration pass.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a duplicate private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-82bb89d7557001cb",
      "path": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts",
      "line": 199,
      "column": 30,
      "kind": "exact-file-tree",
      "contract": "shared-web-browser-entrypoints--limits-the-full-runtime-context-to-the-composer-and-port-contrac",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Enumerates runtime modules and permits full-context access only in the composer and explicit port contracts.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#limits the full runtime context to the composer and port contracts"
    },
    {
      "id": "test-structure-coupling-8353be33dd6eb56f",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 148,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-private-owner-call-after-a-family-registrar-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Places private-owner installation after the family registrar returns, distinguishing reachable construction from token presence.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return"
    },
    {
      "id": "test-structure-coupling-87183e0bc231c821",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 28,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-later-command-object-spread",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Places an operation-changing spread after the approved command property, catching last-write-wins command drift.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a later command-object spread"
    },
    {
      "id": "test-structure-coupling-871c09b8c3bed348",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 34,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Separately excludes a local deriveDistributedRunAnalysisReport declaration so report derivation cannot fork while monitor derivation remains shared.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-885894411448b277",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 1759,
      "column": 26,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--persists-control-server-snapshots-with-an-atomic-temp-file-renam",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Inspects the snapshot writer used in the executed control-server process and verifies persistence crosses the temp-file rename boundary atomically.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#persists control-server snapshots with an atomic temp-file rename"
    },
    {
      "id": "test-structure-coupling-f7231c750a7d2d64",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 125,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Swaps two same-surface arguments at the private-owner call, a defect runtime smoke coverage may not distinguish until values diverge.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects reordered family-to-private-owner arguments"
    },
    {
      "id": "test-structure-coupling-8e6210e8e2b031df",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "line": 30,
      "column": 31,
      "kind": "production-source-read",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Reads the Relic runtime source that owns package imports, keeping the two positive assertions tied to the actual consumer module.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-9283d0d81173e939",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 82,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-computed-result-object-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds a computed result property that overwrites the approved AppInbox type, exercising final object semantics rather than the first visible key.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a computed result-object property"
    },
    {
      "id": "test-structure-coupling-9314da5e1a1a0db9",
      "path": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts",
      "line": 180,
      "column": 30,
      "kind": "exact-file-tree",
      "contract": "shared-web-browser-entrypoints--keeps-mutable-state-cache-access-inside-the-state-store",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Walks every runtime module outside the state store and rejects direct mutable cache access, including future files in that directory.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps mutable state-cache access inside the state store"
    },
    {
      "id": "test-structure-coupling-60ab1835d5ff4dde",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 108,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the direct client registration collection and resolves each handler to the live imported type it actually installs.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#binds direct client registrations to their live types"
    },
    {
      "id": "test-structure-coupling-94d9d2e62057fafc",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 53,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Separately rejects the optional-field spelling so a superficially present gateway cannot remain bypassable.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-974d50f6e89212b8",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "line": 30,
      "column": 21,
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Loads recipe-matrix.json through the same repository-root-aware fixture interface so catalog resolution is tested against the published matrix.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-99ce83992c10422b",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 42,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-computed-command-object-pro",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Overrides the command operation through a computed property, proving the audit evaluates the effective object value.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a computed command-object property"
    },
    {
      "id": "test-structure-coupling-9a9f64b341fce695",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "line": 348,
      "column": 39,
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--keeps-schema-compatibility-guide-json-examples-validating",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Extracts JSON code blocks from the published compatibility guide and submits each example to the real recipe schema validator.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps schema compatibility guide JSON examples validating"
    },
    {
      "id": "test-structure-coupling-7ebd69486497a4f6",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 89,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reorders the root arguments passed into one family registrar, preserving arity while violating ownership position.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-9f19eecfd53fd0c4",
      "path": "packages/tests/repo/auth-server-compatibility-governance.test.ts",
      "line": 156,
      "column": 37,
      "kind": "exact-file-tree",
      "contract": "auth-server-canonical-test-inventory",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "Enumerates the canonical auth test directory so new test files enter the compatibility-import audit instead of escaping a hand-maintained filename list.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-governance.test.ts#keeps every canonical auth test free of compatibility wrappers"
    },
    {
      "id": "test-structure-coupling-a21189fdee14ad9b",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 122,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-removed-private-owner-call-from-the-exported-family-re",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes the family’s only private-owner call, directly testing the missing handoff that would leave routes unowned.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar"
    },
    {
      "id": "test-structure-coupling-8fc3f39a4953f5f3",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "line": 34,
      "column": 21,
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Reads a caller-selected recipe path through the shared loader, providing the exact checked-in YAML/JSON fixture exercised by the topology semantics suite.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-047bddb47bfb4c30",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 65,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates one family registration in the exported root, exercising exactly-once construction rather than simple presence.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root"
    },
    {
      "id": "test-structure-coupling-a888ea7a73ff596c",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 22,
      "column": 28,
      "kind": "production-source-read",
      "contract": "control-protocol-server-import-direction",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Checks the current server module against the forbidden SPA protocol specifier; this is the negative dependency edge that would expose reversed ownership.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server"
    },
    {
      "id": "test-structure-coupling-af4e5d78146d7966",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 68,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-later-result-object-spr",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Appends a spread after the result type property so the effective AppInbox type can differ from the earlier literal.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread"
    },
    {
      "id": "test-structure-coupling-d74e211410ea2681",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 143,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds an unapproved argument at the family/private-owner handoff, catching widened construction that could conceal a second dependency source.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-1a7f6167bcb90129",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "line": 25,
      "column": 31,
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--defines-run-scoped-identifiers-as-interpolated-string-values",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the state-read convergence recipe and inspects its identifier values for run interpolation, rather than validating a copied fixture object.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#defines run-scoped identifiers as interpolated string values"
    },
    {
      "id": "test-structure-coupling-bad22f1371586556",
      "path": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts",
      "line": 70,
      "column": 13,
      "kind": "production-source-read",
      "contract": "shared-web-browser-bundle-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Reads the shared-web package manifest before bundling and confirms graphology is not declared as a direct browser-package dependency.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts#keeps shared-web from declaring graphology directly"
    },
    {
      "id": "test-structure-coupling-65b0463cbe621b05",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 56,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Wraps one root family call in conditional control flow so construction is no longer guaranteed for every server startup.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a conditional family call in the exported root"
    },
    {
      "id": "test-structure-coupling-cb2f95c190c71227",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 95,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-duplicate-direct-appinbox-type-properties-in-the-result-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the direct result type property, rejecting an object whose authoritative outcome depends on property order.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct AppInbox type properties in the result object"
    },
    {
      "id": "test-structure-coupling-cdb26a53c268343a",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "line": 219,
      "column": 24,
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--keeps-the-app-local-rtc-example-self-contained-for-headless-brow",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the shipped app-local RTC recipe and validates that exact example, including the fields a headless agent cannot obtain from app state.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps the app-local RTC example self-contained for headless browser agents"
    },
    {
      "id": "test-structure-coupling-d1e1b5b4cf3102fd",
      "path": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts",
      "line": 31,
      "column": 31,
      "kind": "production-source-read",
      "contract": "api-v1-medium-scale-routing",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the checked-in medium-scale recipe so each group poll’s service name can be compared with the API node that actually executes it.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts#names every group poll for the API node that executes it"
    },
    {
      "id": "test-structure-coupling-9fcf3c8894a57f1c",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 66,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Replaces the auth registrar’s live collection with an empty iterable, testing that a syntactically valid loop cannot mask total registration loss.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects an auth registration loop replaced with an empty iterable"
    },
    {
      "id": "test-structure-coupling-d3bea6363d9e924d",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 135,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-conditional-private-owner-call-in-the-exported-family-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Wraps the presence private-owner invocation in a condition, making the exported family registrar unable to guarantee owner installation.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-db99ed13ba85ff13",
      "path": "packages/tests/repo/auth-server-compatibility-governance.test.ts",
      "line": 47,
      "column": 11,
      "kind": "production-source-read",
      "contract": "auth-server-wrapper-mutation-boundary",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "Loads the wrapper again to introduce a second compatibility hop, exercising directness rather than merely checking the final runtime identity.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-governance.test.ts#rejects export kind, target, and second-hop changes"
    },
    {
      "id": "test-structure-coupling-dfa04fc584084c08",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 109,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-second-exact-registration-in-the-exported-family-regis",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds another exact route registration to the same family, guarding against ambiguous competing handlers.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a second exact registration in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-e0b344b0fbeef139",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 454,
      "column": 13,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--rejects-an-executable-command-scoped-outside-the-source-manifest",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the source manifest as the ownership baseline before injecting a command for another group; the validator must reject that executable scope escape.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#rejects an executable command scoped outside the source manifest group"
    },
    {
      "id": "test-structure-coupling-e20a6d7a4bc018ce",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "line": 197,
      "column": 62,
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads each discovered application recipe example and validates its actual JSON against the published recipe schema.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets"
    },
    {
      "id": "test-structure-coupling-e29235474ce73022",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 365,
      "column": 18,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Re-reads the source manifest after execution and proves isolation was materialized in a copy rather than persisted back into the operator input.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-e2a3f6d14b0ae62f",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 212,
      "column": 13,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--preserves-a-parallel-label-that-happens-to-equal-the-source-room",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Loads the manifest whose parallel label collides with its source room, letting the materializer prove labels and group identities are distinct fields.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#preserves a parallel label that happens to equal the source room"
    },
    {
      "id": "test-structure-coupling-e68cd30bc4c93fff",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 62,
      "column": 7,
      "kind": "migration-or-compatibility-topology",
      "contract": "mutation-route-owner-analysis--requires-the-admin-mutation-gateway-and-contains-no-direct-write",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar server maintainers",
      "rationale": "Classifies every forbidden fallback fragment as compatibility topology, documenting that these historical direct-write paths may not reappear.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-ea26782894acea2f",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "line": 196,
      "column": 32,
      "kind": "exact-file-tree",
      "contract": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Enumerates every .recipe.json application example so newly published fixtures enter schema validation automatically.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets"
    },
    {
      "id": "test-structure-coupling-ead0fd7d9309297d",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 44,
      "column": 12,
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Checks the second enqueue helper in the same module for its own named readonly input object.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-82fec1ab778e1097",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 74,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves a required family call below the root return; the occurrence proves syntactic presence is insufficient when the handoff is unreachable.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family call after an exported-root return"
    },
    {
      "id": "test-structure-coupling-efcc056da2d350b5",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "line": 40,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Requires the adapter to expose RelicHuntersRuntimeDeps, the narrow type contract that replaces the broad shared-web barrel.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-f295701a2edffff0",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 35,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Separately excludes a local deriveRunVerdictView declaration because verdict policy is another independently duplicable part of the same shared owner.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-ebe34ce0111ace64",
      "path": "packages/tests/shared-server/mutation-boundary-analysis.ts",
      "line": 143,
      "column": 22,
      "kind": "exact-file-tree",
      "contract": "mutation-boundary-analysis-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the analyzer module itself to enumerate its exported syntax-aware entrypoint; consumers need this stable repository-test interface for every supported import form.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions"
    },
    {
      "id": "test-structure-coupling-9851060227ac87ee",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 415,
      "column": 20,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable recipe-matrix CLI module whose help text is the published command-line interface under review.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-fa59770e78717a02",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "line": 1878,
      "column": 13,
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--keeps-playwright-packages-aligned-past-the-node-24-browser-insta",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the workflow package-install steps and verifies both Playwright packages advance together beyond the known Node 24 hang combination.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#keeps Playwright packages aligned past the Node 24 browser-install hang regression"
    },
    {
      "id": "test-structure-coupling-fa82e2d5cae95786",
      "path": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts",
      "line": 15,
      "column": 21,
      "kind": "ast-inspection",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Uses the parsed parameter nodes to distinguish one object contract from several positional parameters across both helpers.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-5bc85419a31dcac0",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 134,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes one private-owner argument from a family call, proving the boundary tracks the complete dependency tuple.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-fc2b83186677db6b",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 230,
      "column": 30,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-after-the-handler-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Uses the canonical membership source as the comparison guard after relocating the correct handoff below the handler return.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only after the handler return"
    },
    {
      "id": "test-structure-coupling-fe91fe281f35c6f5",
      "path": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts",
      "line": 206,
      "column": 30,
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-an-uninvoked-nested-hand",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Confirms the nested-function mutant differs from the membership source before requiring rejection of the never-invoked handoff.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function"
    },
    {
      "id": "test-structure-coupling-faeb16e6f7733c4e",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 35,
      "column": 20,
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the package README that developers use to find each shipped RTC benchmark executable and requires one unambiguous row for every approved entrypoint.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-23e33f1c591b5efd",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 51,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the package navigation map to name the actual diagnostics dependency factory used during executable setup.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-3099540a296a159e",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 52,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Rejects the former nonexistent diagnostics setup name so the published executable trace cannot direct developers to an owner that does not exist.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-38bdcd772dead320",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 53,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the data-channel catalog row to identify sendJson as the measured public production operation rather than an internal or nonexistent send surface.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-cdf345896c0cc689",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 54,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Keeps the published listener benchmark timing boundary explicit across construction, connection, and reset instead of implying a narrower interval.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-cd650742e3bdb6e7",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 67,
      "column": 7,
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the durable package map to expose every accepted-baseline command in the exact ten-command grammar owned by the command parser.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-a5a1cbe5425bcd56",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 73,
      "column": 50,
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the accepted workload catalog so maintained diagnostics cannot silently become accepted baseline evidence producers.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-b985d1e99f70025a",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 74,
      "column": 25,
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the package command contract that owns Deno checking for every maintained diagnostic entrypoint.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-0ea66b1a5ba02c32",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "line": 81,
      "column": 7,
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires each named maintained diagnostic entrypoint to remain in the package Deno check command while remaining absent from accepted evidence.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    }
  ]
}
```
