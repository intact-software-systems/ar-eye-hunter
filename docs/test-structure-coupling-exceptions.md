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

The current 116 entries were reviewed by independently meaningful behavior,
not by vocabulary. The metadata below splits these groups further by exact
executable assertion so a broad domain label cannot conceal unrelated evidence.

| Group | Entries | Why structural evidence remains |
| --- | ---: | --- |
| Source-analysis interface | 1 | One parser owner supplies normalized, path-aware analysis to repository tests. |
| Hetzner workflow and Deno runtime | 9 | Executed operations are compared with their emitted artifacts, manifests, and deployed config. |
| Browser control protocol | 7 | Consumers must use the shared protocol owner and not recreate it in the SPA. |
| Auth compatibility | 3 | The complete retained consumer inventory must resolve to canonical runtime identities. |
| Repository style and release interfaces | 2 | Automation consumes stable rule and release-gate mappings. |
| AppInbox transport routing | 7 | Concrete route mutations must fail before they bypass the canonical transaction owner. |
| Mutation-analysis implementation interface | 3 | The audit must follow new files, re-exports, and type declarations fail-closed. |
| Mutation route and owner traversal | 13 | Route, export, helper, and capability evasions must still resolve to AppInbox. |
| Group mutation construction | 14 | Missing, duplicate, reordered, conditional, or rebound owner calls must be rejected. |
| Group HTTP mutation shapes | 17 | Malformed commands, results, registrations, translators, and unreachable handoffs must be rejected. |
| Mutation registration collections and predicates | 12 | Live handler families and exact predicates must remain complete and authoritative. |
| API-v1 recipe loading and routing | 4 | Checked-in recipes and runner plans are executable public test interfaces. |
| State-read convergence recipes | 2 | Parsed fixtures carry run-scoped identity and tertiary causal evidence. |
| Black-box schema and recipe matrix | 8 | Published fixtures, examples, compatibility corpus, and catalog promises are validated directly. |
| State-write recipe evidence | 5 | Parsed command/evidence pairs prove digests, revisions, effects, and execution identity. |
| Shared-web package boundaries | 9 | Consumer imports, browser bundles, and entrypoint inventories enforce package direction. |

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
      "id": "app-inbox-mutation-routing--fails-closed-when-a-named-route-path-uses-an-unknown-expression",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “fails closed when a named route path uses an unknown expression”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#fails closed when a named route path uses an unknown expression",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "app-inbox-mutation-routing--rejects-a-dead-exact-registration-masking-the-live-named-route-o",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “rejects a dead exact registration masking the live named route owner”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a dead exact registration masking the live named route owner",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "app-inbox-mutation-routing--rejects-a-membership-route-constant-swapped-to-the-presence-path",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “rejects a membership route constant swapped to the presence path”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a membership route constant swapped to the presence path",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "app-inbox-mutation-routing--rejects-a-remove-member-route-translated-through-the-ban-operati",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “rejects a remove-member route translated through the ban operation”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a remove-member route translated through the ban operation",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "app-inbox-mutation-routing--rejects-a-translator-case-routed-to-another-operation-type",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “rejects a translator case routed to another operation type”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a translator case routed to another operation type",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "app-inbox-mutation-routing--rejects-a-wrong-local-presence-route-constant",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “rejects a wrong local presence route constant”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a wrong local presence route constant",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "app-inbox-mutation-routing--rejects-an-exact-route-registered-only-from-a-request-time-callb",
      "domain": "Authoritative AppInbox mutation routing",
      "owner": "Rallar server maintainers",
      "summary": "Authoritative state mutations enter through AppInbox-owned routes and cannot bypass their transaction boundary. Executable assertion: “rejects an exact route registered only from a request-time callback”.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects an exact route registered only from a request-time callback",
      "coverageRelation": "The AppInbox transaction suite proves the canonical owner commits mutation, result, effects, and completion atomically; this mutation fixture proves the routing analyzer rejects the named way a transport could bypass or misroute that owner."
    },
    {
      "id": "auth-server-compatibility",
      "domain": "Auth server compatibility ledger",
      "owner": "Rallar repository maintainers",
      "summary": "Every retained auth compatibility consumer is named, bounded, and tied to its canonical runtime owner. Executable assertion: “rejects export kind, target, and second-hop changes”.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts#catches compatibility modules that do not resolve to canonical runtime identities",
      "coverageRelation": "The runtime-identity suite imports every retained compatibility path and proves it resolves directly to the canonical implementation represented by this inventory."
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
      "id": "control-protocol-browser-boundary",
      "domain": "Browser control protocol boundary",
      "owner": "Rallar Black Box maintainers",
      "summary": "The browser client consumes the shared control protocol and rejects app-local protocol duplication. Executable assertion: “keeps distributed run monitor derivation in shared-test instead of the SPA app”.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands",
      "coverageRelation": "The shared-test protocol suite executes the canonical public contract, while this boundary audit proves the browser and control server consume that owner instead of an app-local duplicate."
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
      "id": "group-mutation-construction--rejects-a-family-call-before-resolved-dependencies-and-authoriza",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call before resolved dependencies and authorization exist”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family call before resolved dependencies and authorization exist",
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
      "id": "mutation-capability-type-interface",
      "domain": "Mutation capability type analysis",
      "owner": "Rallar server maintainers",
      "summary": "Capability declarations remain distinguishable from executable authoritative mutation owners. Executable assertion: “maps all 50 entrypoints and 46 types to real registrations and owners”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#maps all 50 entrypoints and 46 types to real registrations and owners",
      "coverageRelation": "The route-owner suite executes type-to-owner mapping over the complete inventory; this AST parse distinguishes type declarations from executable mutation owners."
    },
    {
      "id": "mutation-owner-boundary-traversal",
      "domain": "Mutation owner boundary traversal",
      "owner": "Rallar server maintainers",
      "summary": "The audit follows public exports and injected capabilities to the canonical AppInbox mutation owner. Executable assertion: “uses the canonical inventory in the original routing contract test”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#uses the canonical inventory in the original routing contract test",
      "coverageRelation": "The named traversal test executes a public-export, helper-import, or injected-capability evasion and requires resolution back to the canonical AppInbox owner."
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
      "coverageRelation": "The named predicate test executes an exact, false, imported, or opaque registration filter and requires fail-closed evaluation of the live handler family."
    },
    {
      "id": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “fails closed for an opaque registration predicate”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate",
      "coverageRelation": "The named predicate test executes an exact, false, imported, or opaque registration filter and requires fail-closed evaluation of the live handler family."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the auth registration array with an exact equality filter”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter",
      "coverageRelation": "The named predicate test executes an exact, false, imported, or opaque registration filter and requires fail-closed evaluation of the live handler family."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-group-registration-array-with-an-exact-equality-filt",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the group registration array with an exact equality filter”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the group registration array with an exact equality filter",
      "coverageRelation": "The named predicate test executes an exact, false, imported, or opaque registration filter and requires fail-closed evaluation of the live handler family."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-imported-crdt-collection-with-an-exact-equality-filt",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the imported CRDT collection with an exact equality filter”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the imported CRDT collection with an exact equality filter",
      "coverageRelation": "The named predicate test executes an exact, false, imported, or opaque registration filter and requires fail-closed evaluation of the live handler family."
    },
    {
      "id": "mutation-registration-predicates--rejects-a-group-registration-filter-that-is-always-false",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “rejects a group registration filter that is always false”.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#rejects a group registration filter that is always false",
      "coverageRelation": "The named predicate test executes an exact, false, imported, or opaque registration filter and requires fail-closed evaluation of the live handler family."
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
      "summary": "Governed rule identifiers and workflow registration remain stable for repository automation consumers. Executable assertion: “keeps TypeScript formatter settings aligned with the canonical baseline”.",
      "semanticCoverage": "packages/tests/repo/repo-style-construction-check.test.ts#reports a callback that captures a service assigned after consumer construction",
      "coverageRelation": "The named checker test executes the governed rule and this configuration assertion preserves the identifier through which repository automation selects that behavior."
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
      "id": "test-structure-coupling-042b548b08a48aab",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 108,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-before-resolved-dependencies-and-authoriza",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a family call before resolved dependencies and authorization exist”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a family call before resolved dependencies and authorization exist"
    },
    {
      "id": "test-structure-coupling-043da39cb34cfa87",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 76,
      "column": 26,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--points-every-entry-at-a-catalog-recipe-file",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "The catalog or recipe input “expect(() => readFileSync(path.join(runnerRoot, entry.recipe), 'utf8')).not.toThrow();” is what “points every entry at a catalog recipe file” uses to verify the named uniqueness, coverage, compatibility, or CLI promise across published files.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#points every entry at a catalog recipe file"
    },
    {
      "id": "test-structure-coupling-0472647408807a03",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 151,
      "column": 17,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--forbids-literal-set-values-from-claiming-durable-state-write-evi",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "For “forbids literal SET values from claiming durable state-write evidence”, “readFileSync(path.join(recipeRoot, name), 'utf8'),” loads the command/evidence pair whose digest, revision, effect, or execution identity is then asserted semantically.",
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
      "rationale": "The artifact or input read “await expect(readFile(denoLock, 'utf8')).resolves.toBe('clean\\n');” lets “repairs known Deno lockfile drift before the controlled rollout dirty checkout guard” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#repairs known Deno lockfile drift before the controlled rollout dirty checkout guard"
    },
    {
      "id": "test-structure-coupling-0a1cd607030839cb",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 73,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-crdt-type-removed-from-its-imported-live-registration-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“rejects a CRDT type removed from its imported live registration collection” changes the live registration family through “const source = readFileSync(CRDT_TYPES, 'utf8');”; this occurrence proves the audit follows the authoritative collection rather than a similarly named domain value.",
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
      "rationale": "For “executes the topology exact-revision assertions before every cleanup step”, “const recipe = JSON.parse(readFileSync(path.join(” loads the command/evidence pair whose digest, revision, effect, or execution identity is then asserted semantically.",
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
      "rationale": "For “selects auth ticket races by the redacted secret and exact durable digest”, “const recipe = JSON.parse(readFileSync(path.join(” loads the command/evidence pair whose digest, revision, effect, or execution identity is then asserted semantically.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects auth ticket races by the redacted secret and exact durable digest"
    },
    {
      "id": "test-structure-coupling-12e06bd7a1515caf",
      "path": "packages/tests/shared-server/mutation-boundary-capability-types.ts",
      "line": 234,
      "column": 19,
      "kind": "ast-inspection",
      "contract": "mutation-capability-type-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“maps all 50 entrypoints and 46 types to real registrations and owners” depends on “const program = parse(readFileSync(resolved, 'utf8'), {” to distinguish type declarations from executable mutation owners before comparing the complete inventory.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#maps all 50 entrypoints and 46 types to real registrations and owners"
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
      "rationale": "The artifact or input read “const manifest = JSON.parse(await readFile(path.join(repoRoot, manifestPath), 'utf8'));” lets “prepares the supported commit once before running the serial manifest matrix” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
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
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “expect(source).not.toContain('export function deriveDistributedRunMonitor');” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
    },
    {
      "id": "test-structure-coupling-1b4734649c1d8e9f",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 80,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--rejects-an-exact-route-registered-only-from-a-request-time-callb",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');” creates the precise routing defect named by “rejects an exact route registered only from a request-time callback”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects an exact route registered only from a request-time callback"
    },
    {
      "id": "test-structure-coupling-1bcb566a757b25b4",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 35,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(PRESENCE_ROUTES, 'utf8');” supplies the construction mutation described by “rejects an uninventoryed live private owner and route in a family”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family"
    },
    {
      "id": "test-structure-coupling-1f45a7919de747df",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 53,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--rejects-a-dead-exact-registration-masking-the-live-named-route-o",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');” creates the precise routing defect named by “rejects a dead exact registration masking the live named route owner”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a dead exact registration masking the live named route owner"
    },
    {
      "id": "test-structure-coupling-23e21b30c080db3a",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 385,
      "column": 9,
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "The catalog or recipe input “expect(source).toContain('api-v1-black-box');” is what “advertises the API-v1 profile in recipe-matrix CLI usage” uses to verify the named uniqueness, coverage, compatibility, or CLI promise across published files.",
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
      "rationale": "“expect(read(AUTHORISED_WS_HELPER)).toContain(” is the concrete canonical or mutated module input for “uses one named readonly input object for each authorised websocket enqueue helper”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
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
      "rationale": "The consumer import read “expect(runtimeSource).toContain(” lets “keeps Relic on its runtime adapter boundary without the broad shared-web barrel” prove that this app uses its intended narrow shared-web surface and does not reverse package ownership.",
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
      "rationale": "“expect(source, directFallback).not.toContain(directFallback);” is the concrete canonical or mutated module input for “requires the admin mutation gateway and contains no direct-write fallback”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
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
      "rationale": "The AST parse at “const program = parse(readFileSync(normalized, 'utf8'), {” follows the re-export case exercised by “resolves mutable repository capabilities through the shared-server barrel” until the mutable capability reaches its canonical module.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel"
    },
    {
      "id": "test-structure-coupling-2a7284aec9b1e383",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 117,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(PRESENCE_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a different app passed from a family to its private owner”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "To exercise “rejects an exact registration inside a literal-false owner branch”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “expect(source).toContain('@shared-test/rallar-bb-test/distributed-run-monitor.ts');” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
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
      "rationale": "“expect(source).not.toContain('if (this.options.mutationGateway)');” is the concrete canonical or mutated module input for “requires the admin mutation gateway and contains no direct-write fallback”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
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
      "rationale": "“starts three API servers for every managed Postgres cluster command” reads the real runner manifest at “await readFile(path.join(repoRoot, 'packages/shared-test/package.json'), 'utf8'),” so its three-server command assertion covers the published npm interface rather than a copied command.",
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
      "rationale": "“const source = read(ADMIN_OPERATIONS);” is the concrete canonical or mutated module input for “requires the admin mutation gateway and contains no direct-write fallback”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
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
      "rationale": "To exercise “rejects a separately bound command declared after its submission”, the fixture uses “const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission"
    },
    {
      "id": "test-structure-coupling-46997be678a26e87",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 113,
      "column": 47,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--uses-rallar-signaling-for-signaling-recipe-examples-and-keeps-on",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "The catalog or recipe input “const legacyAliasFixture = JSON.parse(readFileSync(” is what “uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture” uses to verify the named uniqueness, coverage, compatibility, or CLI promise across published files.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture"
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
      "rationale": "“expect(source).toContain('mutationGateway: AdminOperationsMutationGateway;');” is the concrete canonical or mutated module input for “requires the admin mutation gateway and contains no direct-write fallback”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#requires the admin mutation gateway and contains no direct-write fallback"
    },
    {
      "id": "test-structure-coupling-4cf49ab336aca78f",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 81,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects wrong root-to-family arguments”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "“return analyzeSource(readFileSync(filePath, 'utf8'), filePath);” is where the shared helper turns tracked module text into the normalized model exercised by “normalizes TypeScript and TSX module syntax without exposing parser nodes”; without that parse, callers would regain ad hoc parser ownership.",
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
      "rationale": "Repository automation consumes the identifier reached through “const deno = readJson(denoConfigPath) as {”; “keeps TypeScript formatter settings aligned with the canonical baseline” keeps that selector attached to the executable construction rule.",
      "semanticCoverage": "packages/tests/repo/repo-style-construction-check.test.ts#reports a callback that captures a service assigned after consumer construction"
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
      "rationale": "To exercise “rejects an exact registration after an unconditional owner return”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "To exercise “rejects a correct handoff found only in a literal-false handler branch”, the fixture uses “expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "The owned-module inventory at “const runtimeFiles = readdirSync(runtimeDirectory).filter((fileName) =>” is the precise internal surface guarded by “keeps capability controllers behind injected ports”, keeping that runtime capability behind its public entrypoint or injected port.",
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
      "rationale": "To exercise “rejects duplicate direct operation properties in the command object”, the fixture uses “const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "The workflow read “const sharedTestManifest = readJson<PackageManifest>(” is the release-gate half of “keeps TypeScript and Deno checking as separate release gates”, pairing the npm TypeScript command with the separately owned Deno check.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates"
    },
    {
      "id": "test-structure-coupling-5f163dad42005183",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 48,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a family removed from the exported root”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "“uses the control-server Deno config for Hetzner cache warming and systemd start” loads the deployed Deno configuration at “const controlConfig = JSON.parse(await readFile(controlServerConfigPath, 'utf8')) as {” so the assertion follows the same cache and systemd config path used on Hetzner.",
      "semanticCoverage": "packages/tests/hetzner/spa-env-script.test.ts#uses the control-server Deno config for Hetzner cache warming and systemd start"
    },
    {
      "id": "test-structure-coupling-61963fb19df633bb",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 106,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--rejects-a-membership-route-constant-swapped-to-the-presence-path",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_MEMBERSHIP_ROUTES, 'utf8');” creates the precise routing defect named by “rejects a membership route constant swapped to the presence path”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a membership route constant swapped to the presence path"
    },
    {
      "id": "test-structure-coupling-62a137c454ed4aa1",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 83,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-imported-crdt-collection-with-an-exact-equality-filt",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The predicate case named “narrows the imported CRDT collection with an exact equality filter” is expressed at “const source = readFileSync(CRDT_OWNER, 'utf8');”, where fail-closed evaluation must distinguish an exact handler filter from false or opaque logic.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the imported CRDT collection with an exact equality filter"
    },
    {
      "id": "test-structure-coupling-6528188e04f724f8",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 24,
      "column": 17,
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “expect(source, `${file} imports ${forbidden}`).not.toContain(forbidden);” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
    },
    {
      "id": "test-structure-coupling-674f545af17ca390",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 18,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a canonical family name rebound to a different imported family”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “const source = readFileSync('apps/rallar-black-box/src/distributed-recipes.ts', 'utf8');” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
    },
    {
      "id": "test-structure-coupling-6dfda4a637579910",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 80,
      "column": 24,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-crdt-type-removed-from-its-imported-live-registration-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“rejects a CRDT type removed from its imported live registration collection” changes the live registration family through “[CRDT_OWNER, readFileSync(CRDT_OWNER, 'utf8')],”; this occurrence proves the audit follows the authoritative collection rather than a similarly named domain value.",
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
      "rationale": "The artifact or input read “const sourceBefore = await readFile(sourcePath, 'utf8');” lets “materializes a deterministic isolated group throughout executable manifest data” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-6f764d53470df486",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "line": 36,
      "column": 31,
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--proves-tertiary-scalar-and-causal-floors-with-revision-and-sourc",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "The parsed recipe occurrence “const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {” carries the run-scoped or tertiary evidence asserted by “proves tertiary scalar and causal floors with revision and source headers”; removing it would stop exercising that checked-in contract.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#proves tertiary scalar and causal floors with revision and source headers"
    },
    {
      "id": "test-structure-coupling-71fa08fee9fde3c0",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 99,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects an extra root-to-family argument”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument"
    },
    {
      "id": "test-structure-coupling-73308e24266bf2b3",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 68,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The predicate case named “narrows the auth registration array with an exact equality filter” is expressed at “const source = readFileSync(AUTH_OWNER, 'utf8');”, where fail-closed evaluation must distinguish an exact handler filter from false or opaque logic.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter"
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
      "rationale": "The owned-module inventory at “const runtimeFiles = readdirSync(” is the precise internal surface guarded by “keeps runtime controllers independent from the aggregate contract”, keeping that runtime capability behind its public entrypoint or injected port.",
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
      "rationale": "The owned-module inventory at “const runtimeFiles = readdirSync(” is the precise internal surface guarded by “keeps runtime controllers independent from the compatibility entrypoint”, keeping that runtime capability behind its public entrypoint or injected port.",
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
      "rationale": "“const program = parse(read(AUTHORISED_WS_HELPER), {” is the concrete canonical or mutated module input for “uses one named readonly input object for each authorised websocket enqueue helper”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-786f66e97640824a",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 92,
      "column": 19,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--binds-topology-loops-to-their-live-types",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“binds topology loops to their live types” changes the live registration family through “const group = readFileSync(GROUP_OWNER, 'utf8');”; this occurrence proves the audit follows the authoritative collection rather than a similarly named domain value.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#binds topology loops to their live types"
    },
    {
      "id": "test-structure-coupling-78c588b97aca4fac",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 49,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-group-create-removed-from-the-imported-live-group-regist",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“rejects GROUP_CREATE removed from the imported live group registration collection” changes the live registration family through “const source = readFileSync(GROUP_TYPES, 'utf8');”; this occurrence proves the audit follows the authoritative collection rather than a similarly named domain value.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts#rejects GROUP_CREATE removed from the imported live group registration collection"
    },
    {
      "id": "test-structure-coupling-7b8bdb38badaaa52",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 151,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--rejects-a-translator-case-routed-to-another-operation-type",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_COMMAND_TRANSLATOR, 'utf8');” creates the precise routing defect named by “rejects a translator case routed to another operation type”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a translator case routed to another operation type"
    },
    {
      "id": "test-structure-coupling-7d29c8dbac2bcb59",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 166,
      "column": 35,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--uses-one-bounded-execution-identity-for-the-command-and-its-evid",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "For “uses one bounded execution identity for the command and its evidence”, “const recipe = JSON.parse(readFileSync(path.join(” loads the command/evidence pair whose digest, revision, effect, or execution identity is then asserted semantically.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#uses one bounded execution identity for the command and its evidence"
    },
    {
      "id": "test-structure-coupling-7d9fa62ed4f9ff0a",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "line": 127,
      "column": 17,
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--observes-committed-socket-authorization-before-clustered-ws-effe",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "For “observes committed socket authorization before clustered WS effects”, “readFileSync(path.join(recipeRoot, name), 'utf8'),” loads the command/evidence pair whose digest, revision, effect, or execution identity is then asserted semantically.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#observes committed socket authorization before clustered WS effects"
    },
    {
      "id": "test-structure-coupling-7ff401b49afb7583",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 98,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The predicate case named “fails closed for an opaque registration predicate” is expressed at “const source = readFileSync(GROUP_OWNER, 'utf8');”, where fail-closed evaluation must distinguish an exact handler filter from false or opaque logic.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate"
    },
    {
      "id": "test-structure-coupling-802f4bf52c03d28e",
      "path": "packages/tests/repo/auth-server-compatibility-governance.test.ts",
      "line": 38,
      "column": 11,
      "kind": "production-source-read",
      "contract": "auth-server-compatibility",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "The compatibility inventory uses “readRepositorySource(wrapper).replace(” while “rejects export kind, target, and second-hop changes” proves every listed consumer resolves to its direct canonical runtime identity.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts#catches compatibility modules that do not resolve to canonical runtime identities"
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
      "rationale": "To exercise “rejects a duplicate private-owner call in the exported family registrar”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "The owned-module inventory at “const runtimeFiles = readdirSync(” is the precise internal surface guarded by “limits the full runtime context to the composer and port contracts”, keeping that runtime capability behind its public entrypoint or injected port.",
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
      "rationale": "To exercise “rejects a private-owner call after a family-registrar return”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return"
    },
    {
      "id": "test-structure-coupling-84e34b15636855e6",
      "path": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts",
      "line": 73,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-owner-boundary-traversal",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The traversal scenario “uses the canonical inventory in the original routing contract test” reaches “const source = readFileSync(” through an export, helper, or capability edge and must still resolve the mutation to AppInbox.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#uses the canonical inventory in the original routing contract test"
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
      "rationale": "To exercise “rejects an operation overridden by a later command-object spread”, the fixture uses “const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “expect(source).not.toContain('export function deriveDistributedRunAnalysisReport');” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
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
      "rationale": "The artifact or input read “const source = await readFile(” lets “persists control-server snapshots with an atomic temp-file rename” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#persists control-server snapshots with an atomic temp-file rename"
    },
    {
      "id": "test-structure-coupling-8b4a9afb05cb8a4f",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 126,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(PRESENCE_ROUTES, 'utf8');” supplies the construction mutation described by “rejects reordered family-to-private-owner arguments”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "The consumer import read “const runtimeSource = readSource(” lets “keeps Relic on its runtime adapter boundary without the broad shared-web barrel” prove that this app uses its intended narrow shared-web surface and does not reverse package ownership.",
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
      "rationale": "To exercise “rejects an AppInbox type overridden by a computed result-object property”, the fixture uses “const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "The owned-module inventory at “const runtimeFiles = readdirSync(” is the precise internal surface guarded by “keeps mutable state-cache access inside the state store”, keeping that runtime capability behind its public entrypoint or injected port.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-entrypoints.test.ts#keeps mutable state-cache access inside the state store"
    },
    {
      "id": "test-structure-coupling-944da5d76ef196b1",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 103,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“binds direct client registrations to their live types” changes the live registration family through “const client = readFileSync(CLIENT_OWNER, 'utf8');”; this occurrence proves the audit follows the authoritative collection rather than a similarly named domain value.",
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
      "rationale": "“expect(source).not.toContain('mutationGateway?:');” is the concrete canonical or mutated module input for “requires the admin mutation gateway and contains no direct-write fallback”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
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
      "rationale": "“return JSON.parse(readFileSync(path.join(runnerRoot, relativePath), 'utf8'));” is one of the loader's two concrete inputs—repository path or YAML text—used by “defines a no-browser three-server topology convergence recipe” to execute the checked-in recipe shape.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-9833177c97d5402e",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 38,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--rejects-a-wrong-local-presence-route-constant",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');” creates the precise routing defect named by “rejects a wrong local presence route constant”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a wrong local presence route constant"
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
      "rationale": "To exercise “rejects an operation overridden by a computed command-object property”, the fixture uses “const source = readFileSync(MEMBERSHIP_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "“keeps schema compatibility guide JSON examples validating” obtains the exact published fixture/example/corpus at “const blocks = jsonCodeBlocks(readFileSync(schemaCompatibilityGuidePath, 'utf8'));” and sends that value through the schema validator used by consumers.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps schema compatibility guide JSON examples validating"
    },
    {
      "id": "test-structure-coupling-9d37781ac9bd36fb",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 90,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects reordered root-to-family arguments”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-9f19eecfd53fd0c4",
      "path": "packages/tests/repo/auth-server-compatibility-governance.test.ts",
      "line": 156,
      "column": 37,
      "kind": "exact-file-tree",
      "contract": "auth-server-compatibility",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "The compatibility inventory uses “const compatibilityReferences = readdirSync(canonicalAuthTestRoot)” while “rejects export kind, target, and second-hop changes” proves every listed consumer resolves to its direct canonical runtime identity.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts#catches compatibility modules that do not resolve to canonical runtime identities"
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
      "rationale": "To exercise “rejects a removed private-owner call from the exported family registrar”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar"
    },
    {
      "id": "test-structure-coupling-a267014f00d96251",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "line": 26,
      "column": 21,
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "“return JSON.parse(readFileSync(path.join(runnerRoot, 'recipe-matrix.json'), 'utf8'));” is one of the loader's two concrete inputs—repository path or YAML text—used by “defines a no-browser three-server topology convergence recipe” to execute the checked-in recipe shape.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-a268845cf4b958c7",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 114,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The predicate case named “evaluates safe logical includes and identity map chains exactly” is expressed at “const source = readFileSync(AUTH_OWNER, 'utf8');”, where fail-closed evaluation must distinguish an exact handler filter from false or opaque logic.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly"
    },
    {
      "id": "test-structure-coupling-a3e23173670f94ee",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 66,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a duplicate family call in the exported root”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root"
    },
    {
      "id": "test-structure-coupling-a888ea7a73ff596c",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "line": 22,
      "column": 28,
      "kind": "production-source-read",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “const source = readFileSync(file, 'utf8');” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
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
      "rationale": "To exercise “rejects an AppInbox type overridden by a later result-object spread”, the fixture uses “const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread"
    },
    {
      "id": "test-structure-coupling-b046d0deb1646bc4",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 144,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(PRESENCE_ROUTES, 'utf8');” supplies the construction mutation described by “rejects an extra family-to-private-owner argument”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-b227c3f176f70934",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 136,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--fails-closed-when-a-named-route-path-uses-an-unknown-expression",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_PRESENCE_ROUTES, 'utf8');” creates the precise routing defect named by “fails closed when a named route path uses an unknown expression”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#fails closed when a named route path uses an unknown expression"
    },
    {
      "id": "test-structure-coupling-b49789fd23ed38c2",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "line": 24,
      "column": 31,
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--defines-run-scoped-identifiers-as-interpolated-string-values",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "The parsed recipe occurrence “const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {” carries the run-scoped or tertiary evidence asserted by “defines run-scoped identifiers as interpolated string values”; removing it would stop exercising that checked-in contract.",
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
      "rationale": "“keeps shared-web from declaring graphology directly” reads “readFileSync(” to establish the declared dependency set before bundling narrow browser entrypoints and checking their actual graph.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts#keeps shared-web from declaring graphology directly"
    },
    {
      "id": "test-structure-coupling-c58f58d6c340327e",
      "path": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts",
      "line": 78,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "mutation-owner-boundary-traversal",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The traversal scenario “uses the canonical inventory in the original routing contract test” reaches “expect(source).not.toContain('const MUTATION_ROUTE_INVENTORY');” through an export, helper, or capability edge and must still resolve the mutation to AppInbox.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#uses the canonical inventory in the original routing contract test"
    },
    {
      "id": "test-structure-coupling-c65fdd89d62c3de9",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 57,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a conditional family call in the exported root”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "To exercise “rejects duplicate direct AppInbox type properties in the result object”, the fixture uses “const source = readFileSync(COMMAND_TRANSLATOR, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "“keeps the app-local RTC example self-contained for headless browser agents” obtains the exact published fixture/example/corpus at “const recipe = readJsonFile(” and sends that value through the schema validator used by consumers.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps the app-local RTC example self-contained for headless browser agents"
    },
    {
      "id": "test-structure-coupling-d180ce976c85204a",
      "path": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts",
      "line": 77,
      "column": 5,
      "kind": "symbol-assertion",
      "contract": "mutation-owner-boundary-traversal",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The traversal scenario “uses the canonical inventory in the original routing contract test” reaches “expect(source).toContain(\"from './mutation-routing-inventory.ts'\");” through an export, helper, or capability edge and must still resolve the mutation to AppInbox.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts#uses the canonical inventory in the original routing contract test"
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
      "rationale": "The recipe load “const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {” gives “names every group poll for the API node that executes it” the actual poll/service pairs whose named API node must match the convergence evidence.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts#names every group poll for the API node that executes it"
    },
    {
      "id": "test-structure-coupling-d31a3190c19623b1",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 38,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-group-registration-array-with-an-exact-equality-filt",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The predicate case named “narrows the group registration array with an exact equality filter” is expressed at “const source = readFileSync(GROUP_OWNER, 'utf8');”, where fail-closed evaluation must distinguish an exact handler filter from false or opaque logic.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#narrows the group registration array with an exact equality filter"
    },
    {
      "id": "test-structure-coupling-d369671acfc79f49",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts",
      "line": 61,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“rejects an auth registration loop replaced with an empty iterable” changes the live registration family through “const source = readFileSync(AUTH_OWNER, 'utf8');”; this occurrence proves the audit follows the authoritative collection rather than a similarly named domain value.",
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
      "rationale": "To exercise “rejects a conditional private-owner call in the exported family registrar”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-db99ed13ba85ff13",
      "path": "packages/tests/repo/auth-server-compatibility-governance.test.ts",
      "line": 47,
      "column": 11,
      "kind": "production-source-read",
      "contract": "auth-server-compatibility",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "The compatibility inventory uses “readRepositorySource(wrapper).replace(” while “rejects export kind, target, and second-hop changes” proves every listed consumer resolves to its direct canonical runtime identity.",
      "semanticCoverage": "packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts#catches compatibility modules that do not resolve to canonical runtime identities"
    },
    {
      "id": "test-structure-coupling-dcbdd6335044f080",
      "path": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts",
      "line": 53,
      "column": 20,
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--rejects-a-group-registration-filter-that-is-always-false",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The predicate case named “rejects a group registration filter that is always false” is expressed at “const source = readFileSync(GROUP_OWNER, 'utf8');”, where fail-closed evaluation must distinguish an exact handler filter from false or opaque logic.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts#rejects a group registration filter that is always false"
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
      "rationale": "To exercise “rejects a second exact registration in the exported family registrar”, the fixture uses “const source = readFileSync(PRESENCE_ROUTES, 'utf8');” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "The artifact or input read “await readFile(” lets “rejects an executable command scoped outside the source manifest group” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
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
      "rationale": "“validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets” obtains the exact published fixture/example/corpus at “expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, readJsonFile(path.join(appExamplesRoot, fileName)));” and sends that value through the schema validator used by consumers.",
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
      "rationale": "The artifact or input read “expect(await readFile(sourcePath, 'utf8')).toBe(sourceBefore);” lets “materializes a deterministic isolated group throughout executable manifest data” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
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
      "rationale": "The artifact or input read “await readFile(” lets “preserves a parallel label that happens to equal the source room” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
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
      "rationale": "“expect(source, directFallback).not.toContain(directFallback);” is the concrete canonical or mutated module input for “requires the admin mutation gateway and contains no direct-write fallback”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
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
      "rationale": "“validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets” obtains the exact published fixture/example/corpus at “for (const fileName of readdirSync(appExamplesRoot).filter(name => name.endsWith('.recipe.json'))) {” and sends that value through the schema validator used by consumers.",
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
      "rationale": "“expect(read(AUTHORISED_WS_HELPER)).toContain(” is the concrete canonical or mutated module input for “uses one named readonly input object for each authorised websocket enqueue helper”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-ec47d2397c9621d7",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 75,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(ROOT_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a family call after an exported-root return”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "The consumer import read “expect(runtimeSource).toContain('export type RelicHuntersRuntimeDeps');” lets “keeps Relic on its runtime adapter boundary without the broad shared-web barrel” prove that this app uses its intended narrow shared-web surface and does not reverse package ownership.",
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
      "rationale": "For “keeps distributed run monitor derivation in shared-test instead of the SPA app”, “expect(source).not.toContain('export function deriveRunVerdictView');” is the exact import/owner edge checked against the canonical shared-test protocol; the occurrence prevents an app-local protocol fork.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts#accepts the RTC diagnostics option on health commands"
    },
    {
      "id": "test-structure-coupling-f4d3cb333ab20ada",
      "path": "packages/tests/shared-server/mutation-boundary-analysis.ts",
      "line": 144,
      "column": 22,
      "kind": "exact-file-tree",
      "contract": "mutation-boundary-analysis-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const routeFiles = readdirSync('apps/api-v1/src/routes')” enumerates the authoritative route surface supplied to the audit exercised by “exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions”, making newly added routes fail closed instead of disappearing from review.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions"
    },
    {
      "id": "test-structure-coupling-f54a571f6a255e2f",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "line": 383,
      "column": 24,
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "The catalog or recipe input “const source = readFileSync(path.join(runnerRoot, 'recipe-matrix.mts'), 'utf8');” is what “advertises the API-v1 profile in recipe-matrix CLI usage” uses to verify the named uniqueness, coverage, compatibility, or CLI promise across published files.",
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
      "rationale": "The artifact or input read “await readFile(path.join(repoRoot, 'apps/rallar-black-box/package.json'), 'utf8'),” lets “keeps Playwright packages aligned past the Node 24 browser-install hang regression” compare the executed operations result with the durable file operators receive, rather than merely inspecting script spelling.",
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
      "rationale": "“const program = parse(read(AUTHORISED_WS_HELPER), {” is the concrete canonical or mutated module input for “uses one named readonly input object for each authorised websocket enqueue helper”; the analyzer must classify that named owner/path evasion rather than accept a marker elsewhere.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-fad637d78525c610",
      "path": "packages/tests/shared-server/mutation-route-owner-group-construction.test.ts",
      "line": 135,
      "column": 20,
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "“const source = readFileSync(PRESENCE_ROUTES, 'utf8');” supplies the construction mutation described by “rejects a missing family-to-private-owner argument”, allowing the audit to reject that exact rebound, missing, duplicate, or reordered owner call.",
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
      "rationale": "To exercise “rejects a correct handoff found only after the handler return”, the fixture uses “expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
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
      "rationale": "To exercise “rejects a correct handoff found only in an uninvoked nested handler function”, the fixture uses “expect(mutated).not.toBe(readFileSync(MEMBERSHIP_ROUTES, 'utf8'));” as the malformed command/result/control-flow occurrence whose public HTTP handoff must be rejected.",
      "semanticCoverage": "packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function"
    },
    {
      "id": "test-structure-coupling-fea17e209a2be374",
      "path": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts",
      "line": 121,
      "column": 20,
      "kind": "production-source-read",
      "contract": "app-inbox-mutation-routing--rejects-a-remove-member-route-translated-through-the-ban-operati",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "The mutation fixture line “const source = readFileSync(GROUP_MEMBERSHIP_ROUTES, 'utf8');” creates the precise routing defect named by “rejects a remove-member route translated through the ban operation”; rejection proves that transport cannot evade the AppInbox transaction owner.",
      "semanticCoverage": "packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts#rejects a remove-member route translated through the ban operation"
    }
  ]
}
```
