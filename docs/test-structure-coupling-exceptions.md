# Test structure-coupling exception registry

`npm run check:test-structure-coupling` is a full-tree advisory review aid. It detects
tests coupled to production source text, file topology, ASTs, symbol spelling,
source hashes or snapshots, line counts, call/import order, mock invocation
counts or order, hidden browser call logs, browser primitive probes, generated
asset identity, and migration or compatibility topology. A clean report does
not prove that every test is semantic; a candidate is a prompt for human
review, not an automatic failure.

Production code remains the primary design artifact. Delete or replace an
incidental structural test with semantic coverage when production design
improves. Retain one only when it protects an independently stated durable
public, security, compatibility, or interaction boundary, or when it is a
temporary ratchet with a named owner and removal condition. An `interaction`
contract additionally states why its count, absence, or order is independently
observable and required, such as exactly-once payment, idempotency, retry,
cache-suppression, or protocol-order behavior. Do not use this registry as a
blanket baseline or automatic grandfathering mechanism.

The `contracts` section states each independently meaningful domain contract
in human language and links it to the exact executable assertion that proves
the boundary. The assertion may share a file with a candidate only when it
executes the named behavior and the candidate is a concrete input to that
behavior; merely naming the same structural file is not coverage. Each entry
links one exact occurrence to one contract. Its `id`, `path`, and `kind` must
match the checker report exactly, while its rationale explains why that
occurrence is needed by that assertion. Related occurrences share a contract;
distinct executable assertions remain separately reviewable.

An entry's `id` is derived from the occurrence's path, kind, whitespace-normalized
source text, and its occurrence order within the file. It deliberately excludes
line and column so that reformatting cannot re-key a registered review; a change
in what an occurrence _asserts_ re-keys it, a change in where it _sits_ does not.
The checker report still prints the live `path:line:column` for navigation.

Every entry has a named `owner`. A `durable-boundary` entry additionally
declares `boundary` as `public`, `security`, `compatibility`, or `interaction`.
The linked contract for an `interaction` boundary additionally declares a
structured `interactionRequirement` with `interactionKind` (`count`, `absence`,
or `order`), `ownedPort`, `observableEffect`, `requiredConstraint`, and
`failureRationale`. A
`temporary-ratchet` entry additionally
declares an assertion-specific `removalCondition`. Placeholder, escaped
control-only, or vague values such as
`TODO`, `none`, `later`, `...`, `-`, `semantic coverage`, or bracketed
placeholders are not valid evidence. A contract with no current candidates is
also invalid, so this document cannot accumulate orphan approvals.

## Reviewed boundaries

Every retained entry is reviewed through its linked domain contract and exact
executable assertion. The registry metadata below is the sole current inventory;
it is not duplicated in a hand-maintained count or category table that can drift
when tests move or a boundary is removed.

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
      "id": "shared-web-room-formation-command-request",
      "domain": "Shared-web room formation commands",
      "owner": "Shared Web maintainers",
      "summary": "A formation command issues exactly one lifecycle POST under one fresh request id whose body carries the reason and nothing the route's schema does not declare. Executable assertion: “plans through the bound room and accepts the receipt into the cache”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#plans through the bound room and accepts the receipt into the cache",
      "coverageRelation": "The handle test executes plan through the facade and observes the HTTP port the handle owns; the request-id path and first-call body assertions are the wire contract the api-v1 lifecycle route decodes.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Room formation HTTP command port",
        "observableEffect": "One POST per command under one fresh request id, carrying the reason as its only audit field.",
        "requiredConstraint": "Exactly one POST per command; a retry after a typed conflict is a new call with a new request id.",
        "failureRationale": "A second POST under a fresh id would submit the transition twice, and reusing a spent id replays the very denial the retry meant to escape."
      }
    },
    {
      "id": "shared-web-room-formation-connect-fence",
      "domain": "Shared-web room formation connect",
      "owner": "Shared Web maintainers",
      "summary": "A connect with no explicit layout names the cached formation epoch and the planned-slot identity in its one lifecycle POST. Executable assertion: “connects the current planned layout with the cached epoch”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#connects the current planned layout with the cached epoch",
      "coverageRelation": "The handle test seeds the snapshot and the planned slot, executes connect through the facade, and observes the single POST on the HTTP port the handle owns; the body is the fence the server compares.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Room formation HTTP command port",
        "observableEffect": "One connect POST whose body carries the cached epoch and the planned-slot identity.",
        "requiredConstraint": "Exactly one POST carries the fence; a superseded identity is answered by the server, never retried under the same request id.",
        "failureRationale": "Two POSTs would race the fence against itself, and a fence read from anywhere but the cached snapshot and slot could dial a layout the caller never saw."
      }
    },
    {
      "id": "shared-web-room-formation-connect-read-through-order",
      "domain": "Shared-web room formation connect read-through",
      "owner": "Shared Web maintainers",
      "summary": "A connect with no planned layout in the slot reads the group point snapshot before the topology view and spends no lifecycle request. Executable assertion: “refuses to connect locally when no planned layout exists after a read-through”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#refuses to connect locally when no planned layout exists after a read-through",
      "coverageRelation": "The handle test executes connect against an empty planned slot and observes the ordered HTTP calls of the room refresh the handle owns; no lifecycle POST follows the two reads.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Room refresh read-through port",
        "observableEffect": "The group point read precedes the topology read, and no lifecycle POST follows when the slot stays empty.",
        "requiredConstraint": "Topology hydration compares against the group snapshot read immediately before it, and a connect with nothing to name never reaches the server.",
        "failureRationale": "Reading topology first would hydrate against a stale group and could adopt a superseded layout; posting anyway would spend a request id on a guaranteed no-planned-layout conflict."
      }
    },
    {
      "id": "shared-web-room-formation-connect-lagging-snapshot-order",
      "domain": "Shared-web room formation connect read-through",
      "owner": "Shared Web maintainers",
      "summary": "A connect whose planned slot was published past the cached snapshot reads the group point snapshot and then the topology view before its one lifecycle POST names the refreshed epoch. Executable assertion: “reads the room through before connecting when the cached snapshot lags the planned layout”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#reads the room through before connecting when the cached snapshot lags the planned layout",
      "coverageRelation": "The handle test seeds a snapshot behind the planned slot's causal revision, executes connect through the facade, and observes the ordered HTTP calls of the room refresh and the lifecycle port the handle owns; the fence in the POST body is the refreshed epoch.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Room refresh read-through port",
        "observableEffect": "The group point read precedes the topology read, and exactly one connect POST follows carrying the refreshed epoch with the planned-slot identity.",
        "requiredConstraint": "A planned identity newer than the cached snapshot is never posted with the stale epoch; the read-through runs first and the single POST names what it returned.",
        "failureRationale": "Posting the cached epoch with a newer identity earns the untyped stale-epoch 400 the denial reader cannot classify, and a second POST would race the fence against itself."
      }
    },
    {
      "id": "workbench-collection-served-paths",
      "domain": "Rallar server workbench collection addressing",
      "owner": "Shared Test maintainers",
      "summary": "Every workbench REST collection step addresses a path and method the API actually serves. Executable assertion: \u201caddresses paths the API actually serves\u201d.",
      "semanticCoverage": "packages/tests/rallar-black-box/rallar-server-workbench.test.ts#addresses paths the API actually serves",
      "coverageRelation": "The collections are hand-written HTTP paths that nothing executes in CI, so a wrong one is invisible until an operator clicks it and receives a 404. This assertion reads the shipped OpenAPI document \u2014 the published contract, not an internal structure \u2014 and requires a served path and method for every step. No behavioural test can substitute: the collections are operator inputs, never executed by the suite."
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
      "id": "control-protocol-server-import-direction",
      "domain": "Control-server protocol import direction",
      "owner": "Shared Test maintainers",
      "summary": "The control server cannot import the SPA-owned protocol module. Executable assertion: “does not import control protocol from the SPA app into the control server”.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server",
      "coverageRelation": "This approved architecture assertion enumerates the control-server source and rejects the forbidden SPA protocol import. Runtime protocol behavior cannot reveal an app-local fork or a reversed server-to-SPA dependency when both copies still behave alike."
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
      "id": "package-dependency-direction-import-map",
      "domain": "Package dependency direction",
      "owner": "Rallar platform maintainers",
      "summary": "The api-v1 Deno import map advertises no browser or test-only package to application source. Executable assertion: “keeps the api-v1 Deno import map free of browser and test-only packages”.",
      "semanticCoverage": "packages/tests/repo/package-dependency-direction.test.ts#keeps the api-v1 Deno import map free of browser and test-only packages",
      "coverageRelation": "The import-direction suite executes the layering rule over every package source file; this config read covers the one surface that grants resolution before any import exists."
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
      "id": "repo-style-checker-interface",
      "domain": "Repository style checker interface",
      "owner": "Rallar repository maintainers",
      "summary": "Every governed Deno configuration inherits the canonical TypeScript formatter settings. Executable assertion: “keeps TypeScript formatter settings aligned with the canonical baseline”.",
      "semanticCoverage": "packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline",
      "coverageRelation": "The assertion reads each governed Deno config and compares its formatter object with the canonical baseline. Formatting one sample file cannot prove that every repository formatter entrypoint uses the same settings."
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
      "id": "ar-browser-ai-explicit-provider-selection",
      "domain": "AR Eye Hunter browser AI provider selection",
      "owner": "AR Eye Hunter maintainers",
      "summary": "WebLLM failures stay visible and never silently switch an explicitly selected provider mode. Executable assertion: “keeps WebLLM generation failures visible without switching providers”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-browser-ai-provider.test.ts#keeps WebLLM generation failures visible without switching providers",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "AR Eye Hunter mock-provider factory",
        "observableEffect": "A failed WebLLM generation rejects without constructing the mock provider.",
        "requiredConstraint": "The mock-provider factory remains unused after a WebLLM generation failure.",
        "failureRationale": "Constructing the mock provider would hide the selected provider failure and violate explicit mode governance."
      }
    },
    {
      "id": "ar-webllm-engine-lifecycle",
      "domain": "AR Eye Hunter WebLLM engine lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "One lazily loaded WebLLM engine serves every request while each request reaches completion. Executable assertion: “loads one engine, requests JSON mode, and parses JSON results”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts#loads one engine, requests JSON mode, and parses JSON results",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebLLM engine loader and chat-completion port",
        "observableEffect": "Two provider requests initialize one engine and produce two completions.",
        "requiredConstraint": "Engine creation occurs exactly once and completion occurs exactly once per request.",
        "failureRationale": "Extra engine loads repeat an expensive cold start; missing or duplicate completions lose or repeat AI work."
      }
    },
    {
      "id": "ar-arena-reliable-snapshot-coalescing",
      "domain": "AR Eye Hunter reliable snapshot coalescing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Rapid reliable snapshots publish the first revision immediately and the latest once after the coalescing interval. Executable assertion: “coalesces rapid reliable director snapshots to the latest revision”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#coalesces rapid reliable director snapshots to the latest revision",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Rallar Game reliable snapshot publication port",
        "observableEffect": "Revision 20 publishes immediately, no intermediate publication occurs, and revision 22 publishes reliably at the deadline.",
        "requiredConstraint": "The sequence is exactly the first revision followed by the latest after 1,000 milliseconds, with no superseded revision.",
        "failureRationale": "Publishing every revision floods reliable transport; publishing the wrong delayed revision exposes stale state."
      }
    },
    {
      "id": "ar-arena-pending-snapshot-generation-cancellation",
      "domain": "AR Eye Hunter network-generation snapshot fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A network-generation reset cancels a queued reliable snapshot before transport. Executable assertion: “cancels pending reliable director snapshots when the network generation resets”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#cancels pending reliable director snapshots when the network generation resets",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game reliable snapshot publication port",
        "observableEffect": "The immediate snapshot remains the only publication after logout and timer expiry.",
        "requiredConstraint": "No queued second snapshot publishes after the network generation resets.",
        "failureRationale": "A late publication would leak state from a signed-out or superseded connection generation."
      }
    },
    {
      "id": "ar-arena-expired-auth-transition",
      "domain": "AR Eye Hunter expired-auth lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "An auth expiry clears arena state without issuing a manual logout request. Executable assertion: “clears arena state when auth expires outside manual logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#clears arena state when auth expires outside manual logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar auth logout port",
        "observableEffect": "The hook becomes signed out from the auth event without invoking explicit logout.",
        "requiredConstraint": "Auth expiry does not call the manual logout port.",
        "failureRationale": "A second logout duplicates revocation and confuses event versus user-action ownership."
      }
    },
    {
      "id": "ar-arena-manual-logout-rejection",
      "domain": "AR Eye Hunter manual logout failure handling",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Manual logout invokes revocation once and leaves local state signed out even when revocation rejects. Executable assertion: “catches manual logout rejection and leaves the arena signed out”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#catches manual logout rejection and leaves the arena signed out",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Rallar auth logout port",
        "observableEffect": "One user action produces one revocation attempt and a signed-out local state.",
        "requiredConstraint": "The logout port is invoked exactly once for the user action.",
        "failureRationale": "No call skips revocation; repeated calls duplicate a remote side effect."
      }
    },
    {
      "id": "ar-arena-manual-logout-network-fence",
      "domain": "AR Eye Hunter manual logout network fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Manual logout stops networking immediately while one remote revoke remains pending. Executable assertion: “disables network immediately while manual logout revoke is pending”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#disables network immediately while manual logout revoke is pending",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "Rallar auth logout and Rallar Game stop ports",
        "observableEffect": "The match stops before the logout promise resolves while only one revoke is in flight.",
        "requiredConstraint": "One logout request is issued and match networking stops before it settles.",
        "failureRationale": "Waiting leaves gameplay egress active; duplicate revocation repeats the remote mutation."
      }
    },
    {
      "id": "ar-arena-pending-logout-egress-fence",
      "domain": "AR Eye Hunter pending-logout egress fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Canvas callbacks captured before logout cannot publish while revocation is pending. Executable assertion: “blocks stale canvas callbacks while manual logout revoke is pending”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game event, snapshot, intent, input, presence, and raw realtime egress ports",
        "observableEffect": "Invoking stale gameplay callbacks during pending logout produces no network egress.",
        "requiredConstraint": "Every game and raw realtime egress port remains unused until pending logout finishes.",
        "failureRationale": "Any call would transmit gameplay state after the user initiated logout."
      }
    },
    {
      "id": "ar-arena-signed-out-diagnostics-fence",
      "domain": "AR Eye Hunter signed-out diagnostics fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Diagnostics refresh remains local after logout. Executable assertion: “does not probe diagnostics transports after logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "API configuration, ICE candidate, RTC diagnostics, and RTC lane-readiness ports",
        "observableEffect": "Refreshing diagnostics while signed out performs no network or transport probes.",
        "requiredConstraint": "All diagnostics transport ports remain unused after logout.",
        "failureRationale": "Signed-out probes can disclose or recreate connection state after teardown."
      }
    },
    {
      "id": "ar-arena-stale-director-attempt-fence",
      "domain": "AR Eye Hunter director appointment lifecycle",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A director appointment resolving after room clear cannot refresh diagnostics. Executable assertion: “ignores a pending director appointment after the current room clears”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#ignores a pending director appointment after the current room clears",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game diagnostics port",
        "observableEffect": "Diagnostics calls and exposed diagnostics stay unchanged after stale resolution.",
        "requiredConstraint": "Resolving a stale appointment performs no additional diagnostics read.",
        "failureRationale": "A late read would reintroduce state owned by a room that is no longer current."
      }
    },
    {
      "id": "ar-arena-signed-out-snapshot-fence",
      "domain": "AR Eye Hunter signed-out snapshot fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "A snapshot callback captured before logout cannot publish after logout. Executable assertion: “blocks stale canvas snapshot publication after logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas snapshot publication after logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game snapshot publication port",
        "observableEffect": "The stale callback leaves snapshot state empty and produces no publication.",
        "requiredConstraint": "The snapshot publication port remains unused after logout.",
        "failureRationale": "Publishing after logout leaks stale authoritative state from a retired session."
      }
    },
    {
      "id": "ar-arena-signed-out-combat-fence",
      "domain": "AR Eye Hunter signed-out combat fencing",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Combat callbacks captured before logout cannot publish after logout. Executable assertion: “blocks stale canvas combat callbacks after logout”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar Game event, snapshot, intent, input, presence, and raw realtime egress ports",
        "observableEffect": "Stale shot, hit, and pickup callbacks produce no network egress.",
        "requiredConstraint": "Every game and raw realtime egress port remains unused after logout.",
        "failureRationale": "Any call would transmit gameplay state from a signed-out session."
      }
    },
    {
      "id": "ar-arena-create-and-switch-boundary",
      "domain": "AR Eye Hunter arena room switching",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Creating an arena uses atomic create-and-switch rather than create-only. Executable assertion: “creates a new arena by switching rooms and clearing stale remote players”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#creates a new arena by switching rooms and clearing stale remote players",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Rallar room create-only port",
        "observableEffect": "The room switches and stale remote state clears without create-only.",
        "requiredConstraint": "The create-only port remains unused for create-and-switch.",
        "failureRationale": "Create-only would leave switching and old-room cleanup outside the owning workflow."
      }
    },
    {
      "id": "ar-arena-offline-owner-election",
      "domain": "AR Eye Hunter director election",
      "owner": "AR Eye Hunter maintainers",
      "summary": "An online member reports capability and participates in election when the owner is offline. Executable assertion: “auto-appoints regular room members when the owner is offline”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#auto-appoints regular room members when the owner is offline",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Rallar Game capability-report and director-appointment ports",
        "observableEffect": "Startup reports capability and attempts election, producing a succeeded attempt.",
        "requiredConstraint": "Both capability report and appointment attempt occur at least once.",
        "failureRationale": "Omitting either call prevents an ownerless room from recovering director authority."
      }
    },
    {
      "id": "ar-arena-rallar-game-presence-boundary",
      "domain": "AR Eye Hunter pose transport ownership",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Director poses use Rallar Game presence and never bypass it through raw realtime JSON. Executable assertion: “still publishes the local director pose through Rallar Game presence”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#still publishes the local director pose through Rallar Game presence",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Raw Rallar realtime JSON port",
        "observableEffect": "The pose reaches game input and presence while raw motion send stays unused.",
        "requiredConstraint": "No raw realtime JSON motion send occurs for game-owned presence.",
        "failureRationale": "A raw send duplicates policy and bypasses the game-owned presence lifecycle."
      }
    },
    {
      "id": "ar-arena-reliable-snapshot-deduplication",
      "domain": "AR Eye Hunter reliable snapshot deduplication",
      "owner": "AR Eye Hunter maintainers",
      "summary": "Repeated publication of one revision produces one reliable write. Executable assertion: “deduplicates reliable director snapshots by revision”.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#deduplicates reliable director snapshots by revision",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Rallar Game reliable snapshot publication port",
        "observableEffect": "Two local requests for revision 10 produce one reliable publication.",
        "requiredConstraint": "A snapshot revision publishes at most once.",
        "failureRationale": "Duplicate reliable writes waste bandwidth and repeat downstream processing."
      }
    },
    {
      "id": "shared-web-webllm-runtime-lifecycle",
      "domain": "Shared-web WebLLM runtime lifecycle",
      "owner": "Shared Web maintainers",
      "summary": "One lazily loaded WebLLM runtime serves all requests while each request generates an envelope. Executable assertion: “loads one runtime and validates each generated envelope”.",
      "semanticCoverage": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts#loads one runtime and validates each generated envelope",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Shared-web WebLLM runtime loader and generation port",
        "observableEffect": "Two provider requests load one runtime and invoke generation twice.",
        "requiredConstraint": "Runtime loading occurs exactly once and generation occurs once per request.",
        "failureRationale": "Repeated loading repeats cold-start cost; missing or duplicate generations lose or repeat work."
      }
    },
    {
      "id": "shared-web-ticket-429-cooldown",
      "domain": "Shared-web WebSocket ticket cooldown",
      "owner": "Shared Web maintainers",
      "summary": "A 429 suppresses another ticket request until Retry-After expires. Executable assertion: “suppresses repeated ws ticket requests after a 429 response”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#suppresses repeated ws ticket requests after a 429 response",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "Fetch stays at one before expiry and reaches two after recovery.",
        "requiredConstraint": "No second fetch occurs during cooldown and one additional fetch occurs after expiry.",
        "failureRationale": "An early call violates backoff; a missing later call prevents recovery."
      }
    },
    {
      "id": "shared-web-ticket-request-id-retry",
      "domain": "Shared-web WebSocket ticket idempotent retry",
      "owner": "Shared Web maintainers",
      "summary": "A retry after a lost response reuses caller-owned request identity. Executable assertion: “reuses a caller-owned request ID when a ws ticket response is lost”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#reuses a caller-owned request ID when a ws ticket response is lost",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "order",
        "ownedPort": "WebSocket ticket HTTP request URL",
        "observableEffect": "The failed attempt and retry target the same request-ID URL in sequence.",
        "requiredConstraint": "Both ordered attempts use the identical caller-provided request ID.",
        "failureRationale": "Changing the ID defeats server idempotency and can mint duplicate tickets."
      }
    },
    {
      "id": "shared-web-ticket-local-rate-limit",
      "domain": "Shared-web WebSocket ticket local rate limiting",
      "owner": "Shared Web maintainers",
      "summary": "The local limiter suppresses a ticket storm before a second API request. Executable assertion: “locally suppresses ticket storms before hitting the API”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#locally suppresses ticket storms before hitting the API",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "The first request reaches fetch and the next rejects locally.",
        "requiredConstraint": "Only one fetch occurs when the one-request window is exhausted.",
        "failureRationale": "A second fetch bypasses the client storm guard."
      }
    },
    {
      "id": "shared-web-ticket-circuit-breaker",
      "domain": "Shared-web WebSocket ticket circuit breaker",
      "owner": "Shared Web maintainers",
      "summary": "A server failure opens the circuit and suppresses the next request before fetch. Executable assertion: “opens a local circuit after server failures and suppresses the next ticket request”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#opens a local circuit after server failures and suppresses the next ticket request",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "One 503 reaches fetch and the next request fails locally.",
        "requiredConstraint": "Only the first request reaches fetch while the circuit is open.",
        "failureRationale": "A second fetch bypasses the circuit and loads an unavailable server."
      }
    },
    {
      "id": "shared-web-ticket-429-circuit-isolation",
      "domain": "Shared-web WebSocket ticket failure classification",
      "owner": "Shared Web maintainers",
      "summary": "Server rate limiting uses cooldown without opening the failure circuit. Executable assertion: “does not trip the circuit breaker for server 429 cooldown responses”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#does not trip the circuit breaker for server 429 cooldown responses",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "A 429 is followed by a successful fetch after cooldown.",
        "requiredConstraint": "The post-cooldown retry reaches fetch as the second request.",
        "failureRationale": "Treating 429 as circuit failure suppresses valid recovery."
      }
    },
    {
      "id": "shared-web-ticket-circuit-diagnostic-precedence",
      "domain": "Shared-web WebSocket ticket suppression precedence",
      "owner": "Shared Web maintainers",
      "summary": "An open circuit remains the suppression reason after repeated calls. Executable assertion: “keeps circuit-open diagnostics ahead of the local rate limiter while open”.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#keeps circuit-open diagnostics ahead of the local rate limiter while open",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket ticket HTTP fetch port",
        "observableEffect": "One failure opens the circuit and later calls make no network request.",
        "requiredConstraint": "Fetch remains at one while subsequent requests report circuit-open.",
        "failureRationale": "Extra fetches bypass the circuit; rate-limit diagnostics obscure active policy."
      }
    },
    {
      "id": "shared-web-create-room-failure-atomicity",
      "domain": "Shared-web create-and-switch room workflow",
      "owner": "Shared Web maintainers",
      "summary": "Failed room creation leaves the current room and never starts leave. Executable assertion: “does not leave when create fails”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/create-and-join-room.test.ts#does not leave when create fails",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow leave-state-group port",
        "observableEffect": "Create rejects while the old room stays current and no leave occurs.",
        "requiredConstraint": "The leave port remains unused when create fails.",
        "failureRationale": "Leaving after failed creation strands the caller without either room."
      }
    },
    {
      "id": "shared-web-join-room-failure-atomicity",
      "domain": "Shared-web join room workflow",
      "owner": "Shared Web maintainers",
      "summary": "Failed room join leaves the current room and never starts leave. Executable assertion: “does not leave when joining the next room fails”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#does not leave when joining the next room fails",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow leave-state-group port",
        "observableEffect": "Join rejects while the old room stays current and no leave occurs.",
        "requiredConstraint": "The leave port remains unused when join fails.",
        "failureRationale": "Leaving after failed join strands the caller outside both rooms."
      }
    },
    {
      "id": "shared-web-room-reference-validation",
      "domain": "Shared-web room identity validation",
      "owner": "Shared Web maintainers",
      "summary": "Conflicting roomId and roomRef fail before mutation. Executable assertion: “rejects mismatched roomId and roomRef before the workflow”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#rejects mismatched roomId and roomRef before the workflow",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow join-state-group port",
        "observableEffect": "The facade rejects mismatched identity without invoking join.",
        "requiredConstraint": "The join port remains unused for mismatched room identifiers.",
        "failureRationale": "Starting with conflicting identity can join the wrong scoped group."
      }
    },
    {
      "id": "shared-web-leave-without-current-room",
      "domain": "Shared-web leave room resolution",
      "owner": "Shared Web maintainers",
      "summary": "Leaving without a resolvable room performs no mutation or hydration. Executable assertion: “returns undefined without a workflow when no room can be resolved”.",
      "semanticCoverage": "packages/tests/shared-web/rooms/leave-room.test.ts#returns undefined without a workflow when no room can be resolved",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Room workflow leave-state-group and cache hydration ports",
        "observableEffect": "The request completes as a no-op with an empty workflow log.",
        "requiredConstraint": "Neither leave nor hydration runs when no room is resolved.",
        "failureRationale": "Invoking either port would fabricate identity or do unrelated cache work."
      }
    },
    {
      "id": "shared-web-delta-causal-gap-recovery",
      "domain": "Shared-web state-cache delta recovery",
      "owner": "Shared Web maintainers",
      "summary": "A causal gap triggers one durable floored snapshot read. Executable assertion: “pulls the floored group snapshot when a delta envelope arrives over a causal gap”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-delta-recovery.test.ts#pulls the floored group snapshot when a delta envelope arrives over a causal gap",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "One read installs the returned server-canonical snapshot.",
        "requiredConstraint": "Exactly one floored read occurs for the causal-gap envelope.",
        "failureRationale": "No read leaves the gap unresolved; duplicate reads race cache application."
      }
    },
    {
      "id": "shared-web-incomparable-state-recovery",
      "domain": "Shared-web incomparable state recovery",
      "owner": "Shared Web maintainers",
      "summary": "An incomparable tuple performs one durable reread before RTC application. Executable assertion: “recovers incomparable group tuples through a durable reread before RTC recomputation”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#recovers incomparable group tuples through a durable reread before RTC recomputation",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group snapshot durable reread port",
        "observableEffect": "One reread supplies the recovered snapshot applied to RTC and repository.",
        "requiredConstraint": "Exactly one durable reread occurs for the incomparable tuple.",
        "failureRationale": "No reread guesses across histories; duplicates waste and reorder recovery."
      }
    },
    {
      "id": "shared-web-left-session-overlay-removal",
      "domain": "Shared-web state-cache local-session departure",
      "owner": "Shared Web maintainers",
      "summary": "A snapshot dropping the current session uses retention-aware delete, not active update. Executable assertion: “removes overlays but retains RTC connections when an active snapshot no longer includes the current session”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#removes overlays but retains RTC connections when an active snapshot no longer includes the current session",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRTC group-manager active-update port",
        "observableEffect": "The overlay disappears and delete retains connections without accepting active state.",
        "requiredConstraint": "Active update remains unused for a snapshot excluding the current session.",
        "failureRationale": "Accepting it as active recreates local membership."
      }
    },
    {
      "id": "shared-web-directory-only-rtc-reconciliation",
      "domain": "Shared-web directory-only RTC reconciliation",
      "owner": "Shared Web maintainers",
      "summary": "A directory-only snapshot triggers one global RTC reconciliation without per-group mutation. Executable assertion: “reconciles RTC peers when an active directory snapshot excludes the current session”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebRTC group-manager update, delete, and global reconciliation ports",
        "observableEffect": "Active update and delete are skipped while global reconciliation runs once.",
        "requiredConstraint": "Update and delete remain unused while global reconciliation runs exactly once.",
        "failureRationale": "Per-group mutation misstates membership; skipped or duplicate reconciliation leaves or repeats peer work."
      }
    },
    {
      "id": "shared-web-removed-group-cleanup",
      "domain": "Shared-web removed-group cleanup",
      "owner": "Shared Web maintainers",
      "summary": "Removing a cached group deletes RTC tracking without reapplying it. Executable assertion: “cleans up RTC group tracking and notifies listeners when a group snapshot is removed”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#cleans up RTC group tracking and notifies listeners when a group snapshot is removed",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRTC group-manager active-update port",
        "observableEffect": "Removal deletes tracking and notifies listeners with no active update.",
        "requiredConstraint": "Active update remains unused during group removal.",
        "failureRationale": "Reapplying a removed group races deletion and resurrects stale tracking."
      }
    },
    {
      "id": "shared-web-hydration-incomparable-recovery",
      "domain": "Shared-web initialized incomparable recovery",
      "owner": "Shared Web maintainers",
      "summary": "Initialized lifecycle rereads and recomputes once without applying divergent input. Executable assertion: “retains durable incomparable recovery across initialise and hydrate”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group snapshot reread, RTC recomputation, and active-update ports",
        "observableEffect": "Recovered state replaces divergence and drives one recomputation.",
        "requiredConstraint": "Recovery performs one reread and one recomputation while divergent input never reaches active update.",
        "failureRationale": "Missing recovery preserves divergence; duplicates race; active update bypasses the oracle."
      }
    },
    {
      "id": "shared-web-overlay-topology-notification",
      "domain": "Shared-web overlay topology delivery",
      "owner": "Shared Web maintainers",
      "summary": "Every topology envelope notifies RTC while causal rules own cache state. Executable assertion: “applies overlay topology websocket snapshots to the local overlay cache”.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#applies overlay topology websocket snapshots to the local overlay cache",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebRTC group-manager topology notification port",
        "observableEffect": "Initial, removal, and stale envelopes each notify; stale cannot restore removed state.",
        "requiredConstraint": "Notification occurs once per envelope: once after the first and three times after all three.",
        "failureRationale": "Missing notifications leave RTC stale; duplicates repeat repair."
      }
    },
    {
      "id": "shared-web-state-delta-resulting-noop",
      "domain": "Shared-web group-state delta no-op resolution",
      "owner": "Shared Web maintainers",
      "summary": "Equal-resulting and summary no-op deltas resolve without a durable read. Executable assertion: “resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "Typed no-op results return before apply and no fetch occurs.",
        "requiredConstraint": "Recovery fetch remains unused for equal-resulting and summary no-ops.",
        "failureRationale": "Fetching adds latency and can replace equally current state."
      }
    },
    {
      "id": "shared-web-state-delta-resulting-floor",
      "domain": "Shared-web group-state resulting-floor recovery",
      "owner": "Shared Web maintainers",
      "summary": "A dominated cache not matching the predecessor triggers one floored read. Executable assertion: “pulls at the resulting floor when the cached snapshot is dominated but not the predecessor”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the resulting floor when the cached snapshot is dominated but not the predecessor",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "One request at the resulting floor returns canonical state.",
        "requiredConstraint": "Exactly one floored recovery fetch occurs.",
        "failureRationale": "Applying crosses an unproven predecessor; duplicates race reconciliation."
      }
    },
    {
      "id": "shared-web-state-delta-out-of-order-noop",
      "domain": "Shared-web out-of-order delta handling",
      "owner": "Shared Web maintainers",
      "summary": "A delta older than cache resolves without a durable read. Executable assertion: “resolves an out-of-order envelope after a newer snapshot as a no-op”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves an out-of-order envelope after a newer snapshot as a no-op",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "Newer cache state remains authoritative and no fetch occurs.",
        "requiredConstraint": "Recovery fetch remains unused for an envelope dominated by cache.",
        "failureRationale": "Fetching for stale input adds latency and risks replacing newer state."
      }
    },
    {
      "id": "shared-web-state-delta-missing-session-recovery",
      "domain": "Shared-web missing-session delta recovery",
      "owner": "Shared Web maintainers",
      "summary": "Missing active-session material triggers one floored read. Executable assertion: “pulls at the floor when an active session record is missing from the delta and the cache”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the floor when an active session record is missing from the delta and the cache",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "One recovery request supplies canonical session state.",
        "requiredConstraint": "Exactly one floored recovery fetch occurs for the missing session.",
        "failureRationale": "Applying without recovery creates incomplete membership; duplicates waste work."
      }
    },
    {
      "id": "shared-web-state-delta-conflict-recovery",
      "domain": "Shared-web revision-conflict recovery",
      "owner": "Shared Web maintainers",
      "summary": "A revision conflict self-heals with one floored read. Executable assertion: “counts a revision conflict from the divergence oracle and self-heals with the floored pull”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#counts a revision conflict from the divergence oracle and self-heals with the floored pull",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "The conflict produces one recovery request and durable state.",
        "requiredConstraint": "Exactly one floored recovery fetch occurs for the conflict.",
        "failureRationale": "No read leaves divergence unresolved; duplicates race self-healing."
      }
    },
    {
      "id": "shared-web-state-delta-predecessor-apply",
      "domain": "Shared-web predecessor-matched delta application",
      "owner": "Shared Web maintainers",
      "summary": "A predecessor-matched delta applies locally without a durable read. Executable assertion: “applies a delta at the cached predecessor and materializes the server-canonical snapshot”.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#applies a delta at the cached predecessor and materializes the server-canonical snapshot",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Group-state floored HTTP read port",
        "observableEffect": "The delta materializes canonical state and no fetch occurs.",
        "requiredConstraint": "Recovery fetch remains unused when cache matches the delta predecessor.",
        "failureRationale": "Fetching defeats the valid delta fast path and adds latency."
      }
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
      "id": "state-write-recipe-evidence--isolates-crdt-appinbox-evidence-by-command-prefixes",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "CRDT AppInbox evidence selects only the commands owned by its recipe even when another recipe uses a containing update ID. Executable assertion: “isolates CRDT AppInbox evidence by recipe command prefixes”.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#isolates CRDT AppInbox evidence by recipe command prefixes",
      "coverageRelation": "The named recipe test reads the executable CRDT fixture and verifies that its broad durable selector is narrowed by the two exact command-ID prefixes owned by that recipe."
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
      "id": "state-write-recipe-evidence--selects-strict-group-evidence-by-scoped-command-id",
      "domain": "State-write recipe evidence",
      "owner": "Shared Test maintainers",
      "summary": "Strict group evidence follows the scoped internal command identity while retaining operation-specific topology selectors.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects strict group evidence by its scoped internal command identity",
      "coverageRelation": "The named recipe test reads all three executable group state-write fixtures and verifies that their durable selectors use the scoped group AppInbox command prefix."
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
      "id": "tests-project-module-alias-parity",
      "domain": "Tests-project module alias declaration parity",
      "owner": "Rallar repository maintainers",
      "summary": "The tests project declares every module alias the root project and the Vitest runner declare. Executable assertion: “declares every module alias the root project and the vitest runner declare”.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#declares every module alias the root project and the vitest runner declare",
      "coverageRelation": "The same assertion compares the three alias declaration sites against one another; this read supplies the tests-project side of that comparison, which cannot be observed by resolving a module at runtime."
    },
    {
      "id": "tests-typecheck-debt-ledger-shape",
      "domain": "Tests typecheck debt ratchet",
      "owner": "Rallar repository maintainers",
      "summary": "The recorded typecheck debt stays well-formed so the allowlist can only shrink. Executable assertion: “keeps the recorded debt well-formed so the allowlist can only shrink”.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#keeps the recorded debt well-formed so the allowlist can only shrink",
      "coverageRelation": "The assertion recomputes the ledger totals from its own entries and rejects non-positive counts; the ledger file is the only place that state exists, so the read is the assertion's subject rather than an incidental input."
    },
    {
      "id": "typescript-seven-release-boundary",
      "domain": "TypeScript 7 release boundary",
      "owner": "Rallar repository maintainers",
      "summary": "Release automation checks pinned TypeScript workspaces separately from Deno-owned applications. Executable assertion: “keeps TypeScript and Deno checking as separate release gates”.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates",
      "coverageRelation": "The release-boundary test executes the manifest/workflow inspection that keeps npm TypeScript checking separate from Deno checking; this workflow read is its exact release interface."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-conditional-private-owner-call-in-the-exported-family-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a conditional private-owner call in the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-after-the-handler-return",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only after the handler return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only after the handler return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-a-literal-false-handler-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only in a literal-false handler branch”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in a literal-false handler branch",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-an-uninvoked-nested-hand",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a correct handoff found only in an uninvoked nested handler function”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-duplicate-private-owner-call-in-the-exported-family-re",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a duplicate private-owner call in the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a duplicate private-owner call in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-private-owner-call-after-a-family-registrar-return",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a private-owner call after a family-registrar return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-removed-private-owner-call-from-the-exported-family-re",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a removed private-owner call from the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-second-exact-registration-in-the-exported-family-regis",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a second exact registration in the exported family registrar”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a second exact registration in the exported family registrar",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-a-separately-bound-command-declared-after-its-submission",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects a separately bound command declared after its submission”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-computed-result-object-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an AppInbox type overridden by a computed result-object property”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a computed result-object property",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-later-result-object-spr",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an AppInbox type overridden by a later result-object spread”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-exact-registration-after-an-unconditional-owner-retur",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an exact registration after an unconditional owner return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration after an unconditional owner return",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-exact-registration-inside-a-literal-false-owner-branc",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an exact registration inside a literal-false owner branch”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration inside a literal-false owner branch",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-computed-command-object-pro",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an operation overridden by a computed command-object property”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a computed command-object property",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-later-command-object-spread",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects an operation overridden by a later command-object spread”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a later command-object spread",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-duplicate-direct-appinbox-type-properties-in-the-result-",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects duplicate direct AppInbox type properties in the result object”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct AppInbox type properties in the result object",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-http-mutation-contract--rejects-duplicate-direct-operation-properties-in-the-command-obj",
      "domain": "Group HTTP mutation contract",
      "owner": "Rallar server maintainers",
      "summary": "Public group HTTP actions translate into complete canonical AppInbox command shapes. Executable assertion: “rejects duplicate direct operation properties in the command object”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct operation properties in the command object",
      "coverageRelation": "The named HTTP-shape test executes one malformed command, result, registration, control-flow, or translator mutation and requires the analyzer to reject that exact public mutation path."
    },
    {
      "id": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a canonical family name rebound to a different imported family”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a canonical family name rebound to a different imported family",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a conditional family call in the exported root”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a conditional family call in the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a different app passed from a family to its private owner”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a different app passed from a family to its private owner",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a duplicate family call in the exported root”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call after an exported-root return”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call after an exported-root return",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-call-before-authorization-exists",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family call before authorization exists”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call before authorization exists",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a family removed from the exported root”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family removed from the exported root",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects a missing family-to-private-owner argument”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an extra family-to-private-owner argument”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an extra root-to-family argument”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects an uninventoryed live private owner and route in a family”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects reordered family-to-private-owner arguments”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered family-to-private-owner arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects reordered root-to-family arguments”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "domain": "Group mutation construction boundary",
      "owner": "Rallar server maintainers",
      "summary": "Group mutation dependencies are constructed once and route commands to the canonical transaction owner. Executable assertion: “rejects wrong root-to-family arguments”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects wrong root-to-family arguments",
      "coverageRelation": "The named construction test executes one ownership mutation against the group registrar and requires the analyzer to reject the exact missing, duplicated, reordered, or rebound dependency path."
    },
    {
      "id": "mutation-boundary-analysis-interface",
      "domain": "Mutation boundary analysis interface",
      "owner": "Rallar server maintainers",
      "summary": "The routing audit follows imports and exported capabilities through one deterministic analysis model. Executable assertion: “exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions",
      "coverageRelation": "The analyzer test executes import traversal and inventory checks across the authoritative mutation surface; this file enumeration is the fail-closed production input to that security audit."
    },
    {
      "id": "mutation-capability-export-interface",
      "domain": "Mutation capability export analysis",
      "owner": "Rallar server maintainers",
      "summary": "Exported mutation capabilities resolve to their canonical implementation owner before routing assertions run. Executable assertion: “resolves mutable repository capabilities through the shared-server barrel”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel",
      "coverageRelation": "The capability traversal test executes barrel and re-export resolution; this AST parse is the mechanism that follows a mutable capability to its canonical owner."
    },
    {
      "id": "mutation-capability-type-interface",
      "domain": "Mutation capability type analysis",
      "owner": "Rallar server maintainers",
      "summary": "Capability declarations remain distinguishable from executable authoritative mutation owners. Executable assertion: “maps all 56 entrypoints and 52 types to real registrations and owners”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#maps all 56 entrypoints and 52 types to real registrations and owners",
      "coverageRelation": "The route-owner suite executes type-to-owner mapping over the complete inventory; this AST parse distinguishes type declarations from executable mutation owners."
    },
    {
      "id": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “binds direct client registrations to their live types”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#binds direct client registrations to their live types",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-missing-direct-topology-registration",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a missing direct topology registration”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct topology registration",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-missing-direct-crdt-registration",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a missing direct CRDT registration”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct CRDT registration",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects an auth registration loop replaced with an empty iterable”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects an auth registration loop replaced with an empty iterable",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-collections--rejects-a-missing-direct-group-registration",
      "domain": "Mutation handler registration collections",
      "owner": "Rallar server maintainers",
      "summary": "Registration collections include every authoritative mutation family exactly once. Executable assertion: “rejects a missing direct group registration”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct group registration",
      "coverageRelation": "The named collection test executes a removed or rebound live registration family and requires the audit to distinguish authoritative message collections from ordinary domain values."
    },
    {
      "id": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “evaluates safe logical includes and identity map chains exactly”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “fails closed for an opaque registration predicate”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate",
      "coverageRelation": "The named test mutates the live group registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “narrows the auth registration array with an exact equality filter”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-registration-predicates--rejects-an-auth-registration-filter-that-is-always-false",
      "domain": "Mutation registration predicates",
      "owner": "Rallar server maintainers",
      "summary": "Registration predicates accept only authoritative messages owned by their handler family. Executable assertion: “rejects an auth registration filter that is always false”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#rejects an auth registration filter that is always false",
      "coverageRelation": "The named test mutates the live auth registration expression and executes the fail-closed route-owner analyzer; the source read supplies the exact security boundary being mutated."
    },
    {
      "id": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "domain": "Authoritative mutation route ownership",
      "owner": "Rallar server maintainers",
      "summary": "Every authoritative route resolves to one AppInbox transaction owner without a persistence bypass. Executable assertion: “uses one named readonly input object for each authorised websocket enqueue helper”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper",
      "coverageRelation": "The named analyzer test executes a concrete route, type, owner, or fallback mutation and requires the security audit to reject it; each source access supplies the exact mutated module or canonical comparison for that scenario."
    },
    {
      "id": "mutation-route-owner-crdt-reservation-materialization",
      "domain": "CRDT administrative mutation routing",
      "owner": "Rallar repository maintainers",
      "summary": "CRDT reservation construction remains connected to canonical durable AppInbox command materialization. Executable assertion: “rejects a CRDT reservation builder disconnected from command materialization”.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#rejects a CRDT reservation builder disconnected from command materialization",
      "coverageRelation": "The test replaces the actual CRDT administrative route command-materialization call and executes the mutation-route inventory validator; reading that production route is the executable input that proves reservation construction cannot bypass canonical durable AppInbox command materialization."
    },
    {
      "id": "rtc-topology-replay-single-live-send",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "A replayable delivery-log entry produces exactly one live WebSocket send of the immutable outbox message. Executable assertion: “delivers the exact immutable outbox message when the publication is current”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#delivers the exact immutable outbox message when the publication is current",
      "coverageRelation": "The named assertion executes the replay entry handler against a current publication and observes its owned live-send port; the single-send count is the exactly-once delivery constraint of the replay protocol.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WS queue-box live sender (sendToTargetsWithResult)",
        "observableEffect": "One handled replay entry emits one live send carrying the durable outbox message bytes.",
        "requiredConstraint": "Replay emits exactly one live send per handled entry — never zero, never a duplicate.",
        "failureRationale": "A duplicate send would double-deliver topology to members and a missing send would silently drop replayed history, both breaking the at-most-once live half of the replay protocol."
      }
    },
    {
      "id": "rtc-topology-replay-suppressed-send",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "An expired delivery-log entry sends nothing: a retention gap is a typed result the consumer handles, never a stale delivery. Executable assertion: “returns a typed retention gap without attempting a send”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#returns a typed retention gap without attempting a send",
      "coverageRelation": "The named assertion executes the replay entry handler on an expired entry and observes the owned live-send port; the absence of a send is the constraint that expired history never reaches members.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WS queue-box live sender (sendToTargetsWithResult)",
        "observableEffect": "An expired entry resolves to a typed gap with zero live sends.",
        "requiredConstraint": "The live sender remains unused for expired delivery-log entries.",
        "failureRationale": "Sending expired history would deliver stale topology to members instead of surfacing the gap to the replay consumer."
      }
    },
    {
      "id": "rtc-topology-replay-corruption-suppressed-send",
      "domain": "RTC topology replay live delivery",
      "owner": "Rallar server maintainers",
      "summary": "A corrupt delivery-log entry sends nothing: corruption propagates to the replay consumer without reaching the socket. Executable assertion: “propagates corruption for a missing unexpired durable reference”.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#propagates corruption for a missing unexpired durable reference",
      "coverageRelation": "The named assertion executes the replay entry handler on a corrupt entry and observes the owned live-send port; the absence of a send is the constraint that invalid history never reaches members.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WS queue-box live sender (sendToTargetsWithResult)",
        "observableEffect": "A corrupt entry throws to the consumer with zero live sends.",
        "requiredConstraint": "The live sender remains unused for corrupt delivery-log entries.",
        "failureRationale": "Sending invalid history would deliver corrupt topology to members instead of surfacing the corruption to the replay consumer."
      }
    },
    {
      "id": "rtc-connected-observer-delivery",
      "domain": "Native RTC connection observer delivery",
      "owner": "Rallar realtime maintainers",
      "summary": "A native connected transition delivers one established notification while leaving the peer open.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#negotiates offers, forwards ICE candidates, and dispatches remote events",
      "coverageRelation": "The test drives the native connection event and observes the registered establishment callback together with open state and actual signaling outputs.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "QRtcPeerConnection establishment observer",
        "observableEffect": "One native connected transition produces one establishment notification.",
        "requiredConstraint": "The registered onConnected observer runs exactly once for the single connected transition.",
        "failureRationale": "Duplicate registration or dispatch repeats subscriber connection effects even though the peer open state remains identical."
      }
    },
    {
      "id": "rtc-ice-restart-backoff-budget",
      "domain": "Native RTC restart retry budget",
      "owner": "Rallar realtime maintainers",
      "summary": "Concurrent reconnect requests share one timer, and exhausted retries stop allocating native ICE restarts.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#ignores offer collisions when impolite and retries with ICE restart on failure",
      "coverageRelation": "The test advances the retry deadlines, observes the real native restartIce port, and verifies the peer is closed after the configured attempts.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "RTCPeerConnection.restartIce",
        "observableEffect": "The first shared timer produces one restart and the complete retry sequence produces five before reset.",
        "requiredConstraint": "Two concurrent retry requests produce one restart at the first deadline, with five total restarts before exhaustion.",
        "failureRationale": "Extra native restarts exceed the retry budget and duplicate negotiation traffic; missing attempts abandon recovery early."
      }
    },
    {
      "id": "room-send-membership-admission",
      "domain": "Room realtime membership admission before allocation",
      "owner": "Rallar realtime maintainers",
      "summary": "A session outside a room cannot open its peer lanes even when a ready peer is visible.",
      "semanticCoverage": "packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts#does not open or send for a room the current session has not joined",
      "coverageRelation": "The room facade reads scoped membership, returns no targets, and is observed at both the lane-opening port and native data-channel send boundary.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "WebRtcConnectionService.ensurePeerLaneOpen",
        "observableEffect": "An unauthorized room send creates no lane-opening attempt and emits no native frame.",
        "requiredConstraint": "The connection service lane-opening port remains unused when current membership excludes the session.",
        "failureRationale": "Returning no targets after opening a lane would still allocate unauthorized transport and consume establishment work."
      }
    },
    {
      "id": "browser-bridge-authentication-capability",
      "domain": "Browser runtime authentication capability isolation",
      "owner": "Shared Test maintainers",
      "summary": "Missing authentication support fails without substituting a full runtime connection.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts#rejects missing authentication capability without starting a full connection",
      "coverageRelation": "The test calls the public bridge authentication method with a runtime lacking authentication and observes rejection plus the untouched connection port.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "Installed browser Rallar runtime connect capability",
        "observableEffect": "An unsupported authentication request rejects without establishing a runtime session.",
        "requiredConstraint": "The connect capability is never invoked as an authentication fallback.",
        "failureRationale": "Opening a full connection can join rooms and allocate transports for a request that authorized authentication only."
      }
    },
    {
      "id": "browser-bridge-invalid-config-admission",
      "domain": "Browser runtime configuration admission",
      "owner": "Shared Test maintainers",
      "summary": "Valid connection input reaches the installed runtime; malformed configuration is rejected before that side-effect boundary.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts#validates connection configuration before calling the native runtime",
      "coverageRelation": "One valid request and six invalid requests execute the bridge decoder; the forwarded sparse options and only one native connect call prove the boundary.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "Installed browser Rallar runtime connect capability",
        "observableEffect": "Only the valid request reaches native runtime connection; all malformed requests reject beforehand.",
        "requiredConstraint": "Exactly one connect call occurs across the valid request and all rejected configuration cases.",
        "failureRationale": "Rejecting after native connection would still trigger authentication, room membership, or transport allocation with invalid options."
      }
    },
    {
      "id": "browser-ws-subscription-resource-ownership",
      "domain": "Browser WebSocket subscription resource ownership",
      "owner": "Shared Test maintainers",
      "summary": "Repeated requests for one WS subscription share one resource, whose cleanup invokes its disposer once.",
      "semanticCoverage": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts#deduplicates and disposes WS subscriptions while fencing stale leases",
      "coverageRelation": "The resource controller receives the same subscription key twice, fences a stale lease, and is observed at subscription acquisition and disposal ports.",
      "interactionRequirement": {
        "interactionKind": "count",
        "ownedPort": "WebSocket subscription acquisition and unsubscribe disposer",
        "observableEffect": "Two ensure requests acquire one subscription, and cleanup releases that subscription once.",
        "requiredConstraint": "The subscribe callback and its returned unsubscribe callback each run exactly once.",
        "failureRationale": "Duplicate subscription delivers duplicate messages; skipped or duplicate disposal leaks listeners or repeats teardown side effects."
      }
    },
    {
      "id": "group-http-translator-guard-reachability",
      "domain": "Authoritative group mutation route ownership",
      "owner": "Rallar server maintainers",
      "summary": "Input rejection guards and statically unreachable throws preserve a reachable authenticated AppInbox command translator; unconditional throws do not.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#accepts legitimate input rejection guards and an unreachable throwing branch",
      "coverageRelation": "The named test executes the actual route inventory analyzer on the shipped translator and a source mutation adding a false throwing branch. Both must retain the operation connection. Its neighboring parameterized negative executes unconditional throwing guards and requires loss of that connection. Source reads and mutation non-vacuity are inputs to these executable security assertions, not private-name or statement-order requirements."
    }
  ],
  "entries": [
    {
      "id": "test-structure-coupling-1c06d83399d28d75",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-command-request",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The first-call body assertion proves the plan command posts the reason once under a fresh request id.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#plans through the bound room and accepts the receipt into the cache"
    },
    {
      "id": "test-structure-coupling-7f88b9c9cc3c1256",
      "path": "packages/tests/rallar-black-box/rallar-server-workbench.test.ts",
      "kind": "production-source-read",
      "contract": "workbench-collection-served-paths",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the shipped OpenAPI document so a workbench collection cannot ship a path the API does not serve; the collections are operator inputs that no suite executes.",
      "semanticCoverage": "packages/tests/rallar-black-box/rallar-server-workbench.test.ts#addresses paths the API actually serves"
    },
    {
      "id": "test-structure-coupling-a5d5fdeb1214727a",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the package README that developers use to find each shipped RTC benchmark executable and requires one unambiguous row for every approved entrypoint.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-0ce4af5c7c62c033",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the accepted workload catalog so maintained diagnostics cannot silently become accepted baseline evidence producers.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-b4e8f6b00e0259a0",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-read-through-order",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The ordered call list proves the point read precedes the topology read and that no lifecycle POST follows.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#refuses to connect locally when no planned layout exists after a read-through"
    },
    {
      "id": "test-structure-coupling-b604e54c823905c7",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The first-call body assertion proves connect names the cached epoch and the planned-slot identity in its one POST.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#connects the current planned layout with the cached epoch"
    },
    {
      "id": "test-structure-coupling-084da7565a82615e",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-command-request",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The call-count assertion proves the plan command spends exactly one request id; a second POST would submit the transition twice.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#plans through the bound room and accepts the receipt into the cache"
    },
    {
      "id": "test-structure-coupling-1b2a9025717e14f9",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The call-count assertion proves exactly one POST carries the fence; a second would race the fence against itself.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#connects the current planned layout with the cached epoch"
    },
    {
      "id": "test-structure-coupling-00bec008d0fc81d3",
      "path": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-formation-connect-lagging-snapshot-order",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The ordered call list proves the point read and the topology read precede the single connect POST when the cached snapshot lags the planned slot.",
      "semanticCoverage": "packages/tests/shared-web/rooms/formation/create-room-formation.test.ts#reads the room through before connecting when the cached snapshot lags the planned layout"
    },
    {
      "id": "test-structure-coupling-df5e57893203b500",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "production-source-read",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Reads the package command contract that owns Deno checking for every maintained diagnostic entrypoint.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-0fae9273cf2213d7",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Keeps the published listener benchmark timing boundary explicit across construction, connection, and reset instead of implying a narrower interval.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-2156428ddf7703a1",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the package navigation map to name the actual diagnostics dependency factory used during executable setup.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-31ba64718fc4f2d5",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the durable package map to expose every accepted-baseline command in the exact ten-command grammar owned by the command parser.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-d3a4973be65d4f48",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires the data-channel catalog row to identify sendJson as the measured public production operation rather than an internal or nonexistent send surface.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-f9dbd26ba9313d16",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--documents-each-executable-exactly-once-and-discovers-package-tests",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Rejects the former nonexistent diagnostics setup name so the published executable trace cannot direct developers to an owner that does not exist.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#documents each executable exactly once and discovers package tests"
    },
    {
      "id": "test-structure-coupling-a7aa023b12bd5a52",
      "path": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-rtc-bench-navigation--keeps-diagnostics-outside-accepted-baseline-catalog-and-checked-by-deno",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared RTC benchmark maintainers",
      "rationale": "Requires each named maintained diagnostic entrypoint to remain in the package Deno check command while remaining absent from accepted evidence.",
      "semanticCoverage": "packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts#keeps diagnostics outside accepted baseline catalog and checked by Deno"
    },
    {
      "id": "test-structure-coupling-51befb8881f0f6c4",
      "path": "packages/tests/helpers/source-analysis.ts",
      "kind": "ast-inspection",
      "contract": "source-analysis-test-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads source text at the shared helper boundary and immediately converts it into the normalized path-aware analysis model consumed by repository tests.",
      "semanticCoverage": "packages/tests/helpers/source-analysis.test.ts#normalizes TypeScript and TSX module syntax without exposing parser nodes"
    },
    {
      "id": "test-structure-coupling-8bee8864cd2dc720",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--keeps-playwright-packages-aligned-past-the-node-24-browser-insta",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the workflow package-install steps and verifies both Playwright packages advance together beyond the known Node 24 hang combination.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#keeps Playwright packages aligned past the Node 24 browser-install hang regression"
    },
    {
      "id": "test-structure-coupling-9a1ba98a66c78c07",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Captures the source manifest before group materialization so the assertion can compare the generated execution copy without losing its immutable baseline.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-d25b56efbb8aaefe",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--materializes-a-deterministic-isolated-group-throughout-executabl",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Re-reads the source manifest after execution and proves isolation was materialized in a copy rather than persisted back into the operator input.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#materializes a deterministic isolated group throughout executable manifest data"
    },
    {
      "id": "test-structure-coupling-5a80cb6ccad17309",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--persists-control-server-snapshots-with-an-atomic-temp-file-renam",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Inspects the snapshot writer used in the executed control-server process and verifies persistence crosses the temp-file rename boundary atomically.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#persists control-server snapshots with an atomic temp-file rename"
    },
    {
      "id": "test-structure-coupling-4cd9007c14d9f597",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--prepares-the-supported-commit-once-before-running-the-serial-man",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the workflow job steps to establish that checkout preparation precedes, and is not repeated inside, each serial manifest execution.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#prepares the supported commit once before running the serial manifest matrix"
    },
    {
      "id": "test-structure-coupling-3f87efb9ffdb8ee2",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--preserves-a-parallel-label-that-happens-to-equal-the-source-room",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Loads the manifest whose parallel label collides with its source room, letting the materializer prove labels and group identities are distinct fields.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#preserves a parallel label that happens to equal the source room"
    },
    {
      "id": "test-structure-coupling-de62f83dc45c42c1",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--rejects-an-executable-command-scoped-outside-the-source-manifest",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the source manifest as the ownership baseline before injecting a command for another group; the validator must reject that executable scope escape.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#rejects an executable command scoped outside the source manifest group"
    },
    {
      "id": "test-structure-coupling-9d8dac3f600fee05",
      "path": "packages/tests/hetzner/distributed-recipe-workflow.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-distributed-workflow--repairs-known-deno-lockfile-drift-before-the-controlled-rollout-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the rollout workflow order to verify the narrow lockfile repair occurs before the dirty-checkout guard evaluates operator changes.",
      "semanticCoverage": "packages/tests/hetzner/distributed-recipe-workflow.test.ts#repairs known Deno lockfile drift before the controlled rollout dirty checkout guard"
    },
    {
      "id": "test-structure-coupling-2fe7626b3fa35573",
      "path": "packages/tests/hetzner/spa-env-script.test.ts",
      "kind": "production-source-read",
      "contract": "hetzner-control-deno-runtime",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar operations maintainers",
      "rationale": "Reads the deployed control-server Deno config that both cache warming and systemd execute, preventing the host script from validating a different runtime graph.",
      "semanticCoverage": "packages/tests/hetzner/spa-env-script.test.ts#uses the control-server Deno config for Hetzner cache warming and systemd start"
    },
    {
      "id": "test-structure-coupling-ac0caf39b66ad4f6",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "production-source-read",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Forbids a local deriveDistributedRunMonitor declaration, which is the primary duplicate implementation this boundary is intended to prevent.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-d73a5e318b1dd940",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "production-source-read",
      "contract": "control-protocol-server-import-direction",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Checks the current server module against the forbidden SPA protocol specifier; this is the negative dependency edge that would expose reversed ownership.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server"
    },
    {
      "id": "test-structure-coupling-04d3f7b4b3e8b92c",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Opens the SPA distributed-recipes integration module, the single consumer in which a local monitor fork could otherwise hide.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-ba268a86d23e8e22",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Separately excludes a local deriveRunVerdictView declaration because verdict policy is another independently duplicable part of the same shared owner.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-c409a8b44247c577",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Requires the shared-test distributed-run-monitor import, establishing delegation to the package owner rather than copied analysis logic.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-cdb9ea9a75b32d90",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-browser-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Separately excludes a local deriveDistributedRunAnalysisReport declaration so report derivation cannot fork while monitor derivation remains shared.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#keeps distributed run monitor derivation in shared-test instead of the SPA app"
    },
    {
      "id": "test-structure-coupling-571d1d4deeab6f48",
      "path": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts",
      "kind": "symbol-assertion",
      "contract": "control-protocol-server-import-direction",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar Black Box maintainers",
      "rationale": "Reads each enumerated control-server module so the assertion covers the whole server import surface, including files added to the approved inventory.",
      "semanticCoverage": "packages/tests/rallar-black-box/control-protocol-boundary.test.ts#does not import control protocol from the SPA app into the control server"
    },
    {
      "id": "test-structure-coupling-aae795e94c45930d",
      "path": "packages/tests/repo/package-dependency-direction.test.ts",
      "kind": "production-source-read",
      "contract": "package-dependency-direction-import-map",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar platform maintainers",
      "rationale": "Reads the api-v1 Deno import map so a browser or test-only mapping cannot be reintroduced ahead of any import that would use it.",
      "semanticCoverage": "packages/tests/repo/package-dependency-direction.test.ts#keeps the api-v1 Deno import map free of browser and test-only packages"
    },
    {
      "id": "test-structure-coupling-b7b21332a0365fdf",
      "path": "packages/tests/repo/repo-code-style-checker-integrity.test.ts",
      "kind": "production-source-read",
      "contract": "repo-style-checker-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads each enumerated Deno configuration and compares its fmt object with the canonical formatter object consumed by repository automation.",
      "semanticCoverage": "packages/tests/repo/repo-code-style-checker-integrity.test.ts#keeps TypeScript formatter settings aligned with the canonical baseline"
    },
    {
      "id": "test-structure-coupling-75ff9356a64803f3",
      "path": "packages/tests/repo/tests-typecheck-gate.test.ts",
      "kind": "production-source-read",
      "contract": "tests-project-module-alias-parity",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "Alias parity is a property of the declaration files themselves. A resolved import proves one alias works in one runtime; only reading the tests project's own compiler configuration shows whether an alias was dropped from it, which is how @shared-test/* and @relic-hunters/* went missing before.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#declares every module alias the root project and the vitest runner declare"
    },
    {
      "id": "test-structure-coupling-3b86bebc02da01e1",
      "path": "packages/tests/repo/tests-typecheck-gate.test.ts",
      "kind": "production-source-read",
      "contract": "tests-typecheck-debt-ledger-shape",
      "disposition": "durable-boundary",
      "boundary": "compatibility",
      "owner": "Rallar repository maintainers",
      "rationale": "The debt ledger is the ratchet's entire state. Its per-file counts, file count, and total must agree or the gate can be widened by editing one number, so the assertion has to read the recorded file rather than a value derived from it.",
      "semanticCoverage": "packages/tests/repo/tests-typecheck-gate.test.ts#keeps the recorded debt well-formed so the allowlist can only shrink"
    },
    {
      "id": "test-structure-coupling-425fdb5666c550b2",
      "path": "packages/tests/repo/typescript-7-boundaries.test.ts",
      "kind": "production-source-read",
      "contract": "typescript-seven-release-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads the shared-test manifest’s TypeScript check command and pairs it with the independently executed Deno workflow gate.",
      "semanticCoverage": "packages/tests/repo/typescript-7-boundaries.test.ts#keeps TypeScript and Deno checking as separate release gates"
    },
    {
      "id": "test-structure-coupling-2d06815d8f4515a0",
      "path": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts",
      "kind": "production-source-read",
      "contract": "api-v1-medium-scale-routing",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the checked-in medium-scale recipe so each group poll’s service name can be compared with the API node that actually executes it.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-medium-scale-recipe-routing.test.ts#names every group poll for the API node that executes it"
    },
    {
      "id": "test-structure-coupling-852b02185fa347a2",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Reads a caller-selected recipe path through the shared loader, providing the exact checked-in YAML/JSON fixture exercised by the topology semantics suite.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-910b6ad52b88c0f1",
      "path": "packages/tests/shared-test/api-v1-recipe-test-fixture.ts",
      "kind": "production-source-read",
      "contract": "api-v1-recipe-fixture-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Loads recipe-matrix.json through the same repository-root-aware fixture interface so catalog resolution is tested against the published matrix.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-three-server-recipe-semantics.test.ts#defines a no-browser three-server topology convergence recipe"
    },
    {
      "id": "test-structure-coupling-a962763a7f5f7841",
      "path": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts",
      "kind": "production-source-read",
      "contract": "api-v1-runner-plan-interface",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the shared-test package manifest and extracts the real managed Postgres commands whose process plans must contain all three API servers.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-runner-options-and-plans.test.ts#starts three API servers for every managed Postgres cluster command"
    },
    {
      "id": "test-structure-coupling-9e59573d3730f889",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--defines-run-scoped-identifiers-as-interpolated-string-values",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the state-read convergence recipe and inspects its identifier values for run interpolation, rather than validating a copied fixture object.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#defines run-scoped identifiers as interpolated string values"
    },
    {
      "id": "test-structure-coupling-8a8f9cd497a4e870",
      "path": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts",
      "kind": "production-source-read",
      "contract": "state-read-convergence-recipe--proves-tertiary-scalar-and-causal-floors-with-revision-and-sourc",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Rallar server maintainers",
      "rationale": "Loads the convergence recipe section containing tertiary value, revision, and source-header assertions so those causal floors remain executable data.",
      "semanticCoverage": "packages/tests/shared-test/api-v1-state-read-convergence-recipe.test.ts#proves tertiary scalar and causal floors with revision and source headers"
    },
    {
      "id": "test-structure-coupling-2650129d565f6673",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "exact-file-tree",
      "contract": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Enumerates every .recipe.json application example so newly published fixtures enter schema validation automatically.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets"
    },
    {
      "id": "test-structure-coupling-408813ea83585094",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--keeps-schema-compatibility-guide-json-examples-validating",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Extracts JSON code blocks from the published compatibility guide and submits each example to the real recipe schema validator.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps schema compatibility guide JSON examples validating"
    },
    {
      "id": "test-structure-coupling-2e232a0de5fd337a",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--keeps-the-app-local-rtc-example-self-contained-for-headless-brow",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the shipped app-local RTC recipe and validates that exact example, including the fields a headless agent cannot obtain from app state.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#keeps the app-local RTC example self-contained for headless browser agents"
    },
    {
      "id": "test-structure-coupling-501b2d8c133e72a8",
      "path": "packages/tests/shared-test/rallar-bb-test-schema.test.ts",
      "kind": "production-source-read",
      "contract": "black-box-schema-public-interface--validates-recipe-fixtures-examples-flow-exports-manual-snippets-",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads each discovered application recipe example and validates its actual JSON against the published recipe schema.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-schema.test.ts#validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets"
    },
    {
      "id": "test-structure-coupling-fb9c9389cdd8634a",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable recipe-matrix CLI module whose help text is the published command-line interface under review.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-0f68df9519a8ce12",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--points-every-entry-at-a-catalog-recipe-file",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Opens the recipe file referenced by each matrix entry, proving catalog paths resolve to shipped executable fixtures.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#points every entry at a catalog recipe file"
    },
    {
      "id": "test-structure-coupling-9b899f9dd65c29c0",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "production-source-read",
      "contract": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads each catalogued API-v1 recipe as shipped so its declared evidence tier is checked against the evidence source the runner will actually execute.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier"
    },
    {
      "id": "test-structure-coupling-b31fa92c6a3d7af1",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--advertises-the-api-v1-profile-in-recipe-matrix-cli-usage",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Requires the recipe-matrix CLI source to name api-v1-black-box in its usage output, protecting the operator-visible profile selector.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#advertises the API-v1 profile in recipe-matrix CLI usage"
    },
    {
      "id": "test-structure-coupling-dae7a5d0729d2284",
      "path": "packages/tests/shared-test/recipe-matrix.test.ts",
      "kind": "symbol-assertion",
      "contract": "recipe-matrix-public-interface--labels-every-api-v1-entry-with-an-honest-evidence-tier",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Uses the canonical state-write-evidence recipe operator as the exact Tier 2 discriminator; runtime success alone cannot distinguish a public-API assertion from direct SQL evidence.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#labels every api-v1 entry with an honest evidence tier"
    },
    {
      "id": "test-structure-coupling-e59eda4bb5b12d9f",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--executes-the-topology-exact-revision-assertions-before-every-cle",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Parses the topology state-write recipe and compares exact-revision assertion positions with each cleanup command.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#executes the topology exact-revision assertions before every cleanup step"
    },
    {
      "id": "test-structure-coupling-95c57aee7329bbc5",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--forbids-literal-set-values-from-claiming-durable-state-write-evi",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads every state-write recipe selected by the evidence catalog and rejects literal SET payloads that bypass generated durable evidence.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#forbids literal SET values from claiming durable state-write evidence"
    },
    {
      "id": "test-structure-coupling-02a7c0341d254415",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--isolates-crdt-appinbox-evidence-by-command-prefixes",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable CRDT recipe and verifies that durable evidence is narrowed to the command prefixes owned by that recipe instead of a containing ID from another recipe.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#isolates CRDT AppInbox evidence by recipe command prefixes"
    },
    {
      "id": "test-structure-coupling-59a8fed67f047251",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--observes-committed-socket-authorization-before-clustered-ws-effe",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Loads the socket-authorization recipe to verify its commit observation precedes the clustered websocket effect assertion.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#observes committed socket authorization before clustered WS effects"
    },
    {
      "id": "test-structure-coupling-6677491d43bcda4f",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--selects-auth-ticket-races-by-the-redacted-secret-and-exact-durab",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Parses the auth-ticket race recipe so candidate selection is tied to its redacted secret and computed durable digest together.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects auth ticket races by the redacted secret and exact durable digest"
    },
    {
      "id": "test-structure-coupling-982b926666e23ad4",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--selects-strict-group-evidence-by-scoped-command-id",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the executable contract, convergence, and medium-scale recipes to keep durable evidence aligned with the opaque scoped group AppInbox identity.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#selects strict group evidence by its scoped internal command identity"
    },
    {
      "id": "test-structure-coupling-43c0aec131666232",
      "path": "packages/tests/shared-test/state-write-recipe-evidence.test.ts",
      "kind": "production-source-read",
      "contract": "state-write-recipe-evidence--uses-one-bounded-execution-identity-for-the-command-and-its-evid",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Reads the bounded-execution recipe and compares the command identity with the evidence query identity in the same parsed fixture.",
      "semanticCoverage": "packages/tests/shared-test/state-write-recipe-evidence.test.ts#uses one bounded execution identity for the command and its evidence"
    },
    {
      "id": "test-structure-coupling-5f69c532c1ad4ebf",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "kind": "production-source-read",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Reads the Relic runtime source that owns package imports, keeping the two positive assertions tied to the actual consumer module.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-37cbfa5d1c998455",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Requires the adapter to expose RelicHuntersRuntimeDeps, the narrow type contract that replaces the broad shared-web barrel.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-8fb3ab417bf784ac",
      "path": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-browser-ai-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-browser-ai-explicit-provider-selection",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The mock-provider factory absence assertion directly proves that the mock-provider factory remains unused after a WebLLM generation failure.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-browser-ai-provider.test.ts#keeps WebLLM generation failures visible without switching providers"
    },
    {
      "id": "test-structure-coupling-c8b54a0e15713a92",
      "path": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-webllm-engine-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The one-engine creation count directly proves that one engine is created and one completion runs per request.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts#loads one engine, requests JSON mode, and parses JSON results"
    },
    {
      "id": "test-structure-coupling-7bd8747ffd7352aa",
      "path": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-webllm-engine-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The two-request completion count directly proves that one engine is created and one completion runs per request.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/browser-ai/arena-webllm-provider.test.ts#loads one engine, requests JSON mode, and parses JSON results"
    },
    {
      "id": "test-structure-coupling-d3f3345b3e0c0aca",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The immediate single-publication count directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-1bc723f2706cc67a",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unchanged pre-deadline publication count directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-8965491a17b28c8c",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The post-deadline two-publication count directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-3da9554c3b61b3dd",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-coalescing",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The delayed publication reliable-options assertion directly proves that the first revision publishes immediately and the latest publishes reliably after the interval without the superseded revision.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#coalesces rapid reliable director snapshots to the latest revision"
    },
    {
      "id": "test-structure-coupling-ddcc353b38f840bc",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-snapshot-generation-cancellation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The initial one-publication baseline directly proves that no queued second snapshot publishes after the generation resets.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#cancels pending reliable director snapshots when the network generation resets"
    },
    {
      "id": "test-structure-coupling-deb29b8fd46fada2",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-snapshot-generation-cancellation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unchanged count after reset and timer expiry directly proves that no queued second snapshot publishes after the generation resets.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#cancels pending reliable director snapshots when the network generation resets"
    },
    {
      "id": "test-structure-coupling-84f796b5286f7e78",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-expired-auth-transition",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The explicit-logout absence assertion directly proves that auth expiry does not invoke manual logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#clears arena state when auth expires outside manual logout"
    },
    {
      "id": "test-structure-coupling-c8cc6ca7cb852a53",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-manual-logout-rejection",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The exactly-once logout assertion directly proves that one user action invokes the logout port exactly once.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#catches manual logout rejection and leaves the arena signed out"
    },
    {
      "id": "test-structure-coupling-13076aa50d1ea217",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-manual-logout-network-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The exactly-one pending logout assertion directly proves that one logout is in flight and match networking stops before it settles.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#disables network immediately while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-d67b0dbb22713a47",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-manual-logout-network-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The pre-settlement match-stop assertion directly proves that one logout is in flight and match networking stops before it settles.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#disables network immediately while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-d3a4e20d284cf55d",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The event-publication absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-055c1e0ac2372b82",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The snapshot-publication absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-beb532cd752c825d",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-intent absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-df15c9e78f685c1e",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-input absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-d7e8e578c65502fe",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-presence absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-3da6902b742cfa96",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime room-port absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-edd22a871f21acc5",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-pending-logout-egress-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime JSON-send absence assertion directly proves that all game and raw realtime egress remains unused during pending logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas callbacks while manual logout revoke is pending"
    },
    {
      "id": "test-structure-coupling-4f361679b46fee6d",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The API configuration read absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-9ffd9b32eeafe8a5",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The ICE candidate read absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-f666b2b3080c639f",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The RTC diagnostics absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-4bae375e2e93de59",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-diagnostics-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The room-lane wait absence assertion directly proves that all diagnostics transport ports remain unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#does not probe diagnostics transports after logout"
    },
    {
      "id": "test-structure-coupling-6c3ccce322d89ce4",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-stale-director-attempt-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The unchanged diagnostics count directly proves that stale appointment resolution performs no additional diagnostics read.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#ignores a pending director appointment after the current room clears"
    },
    {
      "id": "test-structure-coupling-d1dd13ef89b32432",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-snapshot-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The signed-out snapshot-publication absence assertion directly proves that snapshot publication remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas snapshot publication after logout"
    },
    {
      "id": "test-structure-coupling-dfffce7877dc1c8e",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The event-publication absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-08fc7607c4037299",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The snapshot-publication absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-49bd5bca406b4f70",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-intent absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-826d23c83753ba6a",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-input absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-83ad6138dc7baf89",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The game-presence absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-e4743fcd4966da2a",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime room-port absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-56ec10185434a41c",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-signed-out-combat-fence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw realtime JSON-send absence assertion directly proves that all game and raw realtime egress remains unused after logout.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#blocks stale canvas combat callbacks after logout"
    },
    {
      "id": "test-structure-coupling-69f6c6dd1aaada67",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-create-and-switch-boundary",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The create-only port absence assertion directly proves that create-only remains unused during create-and-switch.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#creates a new arena by switching rooms and clearing stale remote players"
    },
    {
      "id": "test-structure-coupling-1e082c65080293d4",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-offline-owner-election",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The capability-report invocation assertion directly proves that capability reporting and appointment both occur for an eligible member.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#auto-appoints regular room members when the owner is offline"
    },
    {
      "id": "test-structure-coupling-b3578e40d71b81cd",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-offline-owner-election",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The director-appointment invocation assertion directly proves that capability reporting and appointment both occur for an eligible member.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#auto-appoints regular room members when the owner is offline"
    },
    {
      "id": "test-structure-coupling-313ee2116e5ba688",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-rallar-game-presence-boundary",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The raw motion-lane send absence assertion directly proves that raw realtime motion send remains unused for game-owned presence.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#still publishes the local director pose through Rallar Game presence"
    },
    {
      "id": "test-structure-coupling-f7c28d6e20d2d1f7",
      "path": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "ar-arena-reliable-snapshot-deduplication",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "AR Eye Hunter maintainers",
      "rationale": "The single-publication count directly proves that a repeated revision produces one reliable publication.",
      "semanticCoverage": "packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts#deduplicates reliable director snapshots by revision"
    },
    {
      "id": "test-structure-coupling-1ad6c91810eec4cf",
      "path": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-webllm-runtime-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The one-runtime load count directly proves that one runtime loads and one generation occurs per request.",
      "semanticCoverage": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts#loads one runtime and validates each generated envelope"
    },
    {
      "id": "test-structure-coupling-82150a150dd9cdc9",
      "path": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-webllm-runtime-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-request generation count directly proves that one runtime loads and one generation occurs per request.",
      "semanticCoverage": "packages/tests/shared-web/ai/webllm-rallar-ai-provider.test.ts#loads one runtime and validates each generated envelope"
    },
    {
      "id": "test-structure-coupling-754469ae55dc224e",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-429-cooldown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The one-fetch count during cooldown directly proves that no fetch occurs during cooldown and one occurs after expiry.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#suppresses repeated ws ticket requests after a 429 response"
    },
    {
      "id": "test-structure-coupling-d594acd0cc318bff",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-429-cooldown",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-fetch count after recovery directly proves that no fetch occurs during cooldown and one occurs after expiry.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#suppresses repeated ws ticket requests after a 429 response"
    },
    {
      "id": "test-structure-coupling-199b77b998e88fb9",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-request-id-retry",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The ordered identical request-URL pair directly proves that both ordered attempts use the caller-provided request ID.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#reuses a caller-owned request ID when a ws ticket response is lost"
    },
    {
      "id": "test-structure-coupling-ca6f4205c8df55db",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-local-rate-limit",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The single-fetch count directly proves that only one fetch occurs when the local window is exhausted.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#locally suppresses ticket storms before hitting the API"
    },
    {
      "id": "test-structure-coupling-3983fdfe47629f46",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-circuit-breaker",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The single-fetch count directly proves that only the first request reaches fetch while the circuit is open.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#opens a local circuit after server failures and suppresses the next ticket request"
    },
    {
      "id": "test-structure-coupling-dc78d510b5a27800",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-429-circuit-isolation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The two-fetch recovery count directly proves that the post-cooldown retry reaches fetch as the second request.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#does not trip the circuit breaker for server 429 cooldown responses"
    },
    {
      "id": "test-structure-coupling-33d4b8eafdb3cd41",
      "path": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-ticket-circuit-diagnostic-precedence",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The unchanged one-fetch count directly proves that fetch remains at one across repeated circuit-open requests.",
      "semanticCoverage": "packages/tests/shared-web/auth/websocket-ticket-http-api.test.ts#keeps circuit-open diagnostics ahead of the local rate limiter while open"
    },
    {
      "id": "test-structure-coupling-b501ba3cfcd7af87",
      "path": "packages/tests/shared-web/rooms/create-and-join-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-create-room-failure-atomicity",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The leave-step absence assertion directly proves that leave remains unused after create failure.",
      "semanticCoverage": "packages/tests/shared-web/rooms/create-and-join-room.test.ts#does not leave when create fails"
    },
    {
      "id": "test-structure-coupling-c61c5f883b0852dc",
      "path": "packages/tests/shared-web/rooms/join-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-join-room-failure-atomicity",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The leave-step absence assertion directly proves that leave remains unused after join failure.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#does not leave when joining the next room fails"
    },
    {
      "id": "test-structure-coupling-6a8b145413d657dc",
      "path": "packages/tests/shared-web/rooms/join-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-room-reference-validation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The join-step absence assertion directly proves that join remains unused for mismatched identity.",
      "semanticCoverage": "packages/tests/shared-web/rooms/join-room.test.ts#rejects mismatched roomId and roomRef before the workflow"
    },
    {
      "id": "test-structure-coupling-ba2c2e56b2ad2530",
      "path": "packages/tests/shared-web/rooms/leave-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-leave-without-current-room",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The leave-step absence assertion directly proves that neither leave nor hydration runs without a room.",
      "semanticCoverage": "packages/tests/shared-web/rooms/leave-room.test.ts#returns undefined without a workflow when no room can be resolved"
    },
    {
      "id": "test-structure-coupling-4e2fd8e52aed7476",
      "path": "packages/tests/shared-web/rooms/leave-room.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-leave-without-current-room",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The hydration-step absence assertion directly proves that neither leave nor hydration runs without a room.",
      "semanticCoverage": "packages/tests/shared-web/rooms/leave-room.test.ts#returns undefined without a workflow when no room can be resolved"
    },
    {
      "id": "test-structure-coupling-67f803ee1f1dfc75",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-delta-recovery.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-delta-causal-gap-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one floored recovery read occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-delta-recovery.test.ts#pulls the floored group snapshot when a delta envelope arrives over a causal gap"
    },
    {
      "id": "test-structure-coupling-cbe469634a266398",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-incomparable-state-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one reread assertion directly proves that exactly one durable reread occurs for the incomparable tuple.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#recovers incomparable group tuples through a durable reread before RTC recomputation"
    },
    {
      "id": "test-structure-coupling-025be7ee49840bd9",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-left-session-overlay-removal",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The active-update absence assertion directly proves that active update remains unused for local-session departure.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#removes overlays but retains RTC connections when an active snapshot no longer includes the current session"
    },
    {
      "id": "test-structure-coupling-e1765609fc916748",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-directory-only-rtc-reconciliation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The active-update absence assertion directly proves that update and delete remain unused while global reconciliation runs once.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session"
    },
    {
      "id": "test-structure-coupling-497bb478e2668c0b",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-directory-only-rtc-reconciliation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The delete absence assertion directly proves that update and delete remain unused while global reconciliation runs once.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session"
    },
    {
      "id": "test-structure-coupling-b916315de75a02bd",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-directory-only-rtc-reconciliation",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one global reconciliation assertion directly proves that update and delete remain unused while global reconciliation runs once.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#reconciles RTC peers when an active directory snapshot excludes the current session"
    },
    {
      "id": "test-structure-coupling-a11ab393ae38189f",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-removed-group-cleanup",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The active-update absence assertion directly proves that active update remains unused during group removal.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#cleans up RTC group tracking and notifies listeners when a group snapshot is removed"
    },
    {
      "id": "test-structure-coupling-d5f5da64d4239c75",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-hydration-incomparable-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one durable reread assertion directly proves that one reread and recomputation occur while divergent input is not applied.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate"
    },
    {
      "id": "test-structure-coupling-1805f0024d06f752",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-hydration-incomparable-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one RTC recomputation assertion directly proves that one reread and recomputation occur while divergent input is not applied.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate"
    },
    {
      "id": "test-structure-coupling-f9d11d5598249f3f",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-hydration-incomparable-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The divergent active-update absence assertion directly proves that one reread and recomputation occur while divergent input is not applied.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#retains durable incomparable recovery across initialise and hydrate"
    },
    {
      "id": "test-structure-coupling-938ac1b9663ee78e",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-overlay-topology-notification",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The one-notification count after the first envelope directly proves that notification occurs exactly once per topology envelope.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#applies overlay topology websocket snapshots to the local overlay cache"
    },
    {
      "id": "test-structure-coupling-62267828560f3742",
      "path": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-overlay-topology-notification",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The three-notification count after all envelopes directly proves that notification occurs exactly once per topology envelope.",
      "semanticCoverage": "packages/tests/shared-web/state-cache/browser-state-cache-lifecycle.test.ts#applies overlay topology websocket snapshots to the local overlay cache"
    },
    {
      "id": "test-structure-coupling-b2dd16cf6147955c",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-resulting-noop",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The recovery-fetch absence assertion directly proves that recovery fetch remains unused for typed no-ops.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule"
    },
    {
      "id": "test-structure-coupling-ad89c9ae9a021e02",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-resulting-floor",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one resulting-floor fetch occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the resulting floor when the cached snapshot is dominated but not the predecessor"
    },
    {
      "id": "test-structure-coupling-e73fb539a6935723",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-out-of-order-noop",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The recovery-fetch absence assertion directly proves that recovery fetch remains unused for stale input.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#resolves an out-of-order envelope after a newer snapshot as a no-op"
    },
    {
      "id": "test-structure-coupling-505ac7ff6ccdc8a1",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-missing-session-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one missing-session recovery fetch occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#pulls at the floor when an active session record is missing from the delta and the cache"
    },
    {
      "id": "test-structure-coupling-1b3d4d2848352f1b",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-conflict-recovery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The exactly-one recovery fetch assertion directly proves that exactly one conflict recovery fetch occurs.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#counts a revision conflict from the divergence oracle and self-heals with the floored pull"
    },
    {
      "id": "test-structure-coupling-8339924aecbb8ee7",
      "path": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-state-delta-predecessor-apply",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The recovery-fetch absence assertion directly proves that recovery fetch remains unused for predecessor-matched application.",
      "semanticCoverage": "packages/tests/shared-web/state-read/group-state-delta-reconciliation.test.ts#applies a delta at the cached predecessor and materializes the server-canonical snapshot"
    },
    {
      "id": "test-structure-coupling-c5144d99d1ea326b",
      "path": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts",
      "kind": "symbol-assertion",
      "contract": "shared-web-app-import-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Requires the Relic runtime module to import its narrow browser adapter, recording the consumer-to-adapter dependency edge.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-app-import-boundaries.test.ts#keeps Relic on its runtime adapter boundary without the broad shared-web barrel"
    },
    {
      "id": "test-structure-coupling-1a8f6bf9501e1e11",
      "path": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts",
      "kind": "production-source-read",
      "contract": "shared-web-browser-bundle-boundary",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Web maintainers",
      "rationale": "Reads the shared-web package manifest before bundling and confirms graphology is not declared as a direct browser-package dependency.",
      "semanticCoverage": "packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts#keeps shared-web from declaring graphology directly"
    },
    {
      "id": "test-structure-coupling-70a87a1f1ea479cd",
      "path": "packages/tests/repo/mutation-route-ownership/boundary/mutation-boundary-analysis.ts",
      "kind": "exact-file-tree",
      "contract": "mutation-boundary-analysis-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Parses the analyzer module itself to enumerate its exported syntax-aware entrypoint; consumers need this stable repository-test interface for every supported import form.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions"
    },
    {
      "id": "test-structure-coupling-f75b3422e50b6549",
      "path": "packages/tests/repo/mutation-route-ownership/boundary/capabilities/mutation-boundary-capability-exports.ts",
      "kind": "ast-inspection",
      "contract": "mutation-capability-export-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the shared-server barrel as the starting export graph, proving mutable capabilities remain traceable through the package public surface.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-boundary-traversal.test.ts#resolves mutable repository capabilities through the shared-server barrel"
    },
    {
      "id": "test-structure-coupling-78bf1368cf214172",
      "path": "packages/tests/repo/mutation-route-ownership/boundary/capabilities/mutation-boundary-capability-types.ts",
      "kind": "ast-inspection",
      "contract": "mutation-capability-type-interface",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Inspects the canonical capability declarations so every inventoried mutation type can be joined to an actual registration and owner.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#maps all 56 entrypoints and 52 types to real registrations and owners"
    },
    {
      "id": "test-structure-coupling-5ac40266b15fed40",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "ast-inspection",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Uses the parsed parameter nodes to distinguish one object contract from several positional parameters across both helpers.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-7c5aa61574c59a94",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Requires the authorised websocket helper to accept its first named readonly input object rather than a positional mutation tuple.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-9f3ecb4406f3911a",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads and parses that helper module so parameter declarations are evaluated as syntax, not brittle substring matches.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-52beab5de7d2f568",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-analysis--uses-one-named-readonly-input-object-for-each-authorised-websock",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Checks the second enqueue helper in the same module for its own named readonly input object.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#uses one named readonly input object for each authorised websocket enqueue helper"
    },
    {
      "id": "test-structure-coupling-755638c9349907da",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-canonical-family-name-rebound-to-a-different-imported-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the exported root before rebinding a canonical family identifier to another imported registrar, testing binding identity rather than call spelling.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a canonical family name rebound to a different imported family"
    },
    {
      "id": "test-structure-coupling-a953d677a6a4e37d",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-conditional-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Wraps one root family call in conditional control flow so construction is no longer guaranteed for every server startup.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a conditional family call in the exported root"
    },
    {
      "id": "test-structure-coupling-f2014ef62de286a9",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-different-app-passed-from-a-family-to-its-private-owne",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Mutates the family-to-owner call to pass a different app object, isolating instance continuity across the private ownership boundary.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a different app passed from a family to its private owner"
    },
    {
      "id": "test-structure-coupling-c7927fc092bac2c7",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-duplicate-family-call-in-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates one family registration in the exported root, exercising exactly-once construction rather than simple presence.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a duplicate family call in the exported root"
    },
    {
      "id": "test-structure-coupling-503ee8c186f47263",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-after-an-exported-root-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves a required family call below the root return; the occurrence proves syntactic presence is insufficient when the handoff is unreachable.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call after an exported-root return"
    },
    {
      "id": "test-structure-coupling-ee9090eba9fc708c",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-call-before-authorization-exists",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves family construction ahead of authorization resolution, testing lifecycle order at the root composition boundary.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family call before authorization exists"
    },
    {
      "id": "test-structure-coupling-ce59f3bf64ba0cda",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-family-removed-from-the-exported-root",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Deletes one canonical family invocation from the root fixture so the analyzer must report the missing owner family.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a family removed from the exported root"
    },
    {
      "id": "test-structure-coupling-cc694049a6a7199b",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes one private-owner argument from a family call, proving the boundary tracks the complete dependency tuple.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-0b58d02400285f7d",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds an unapproved argument at the family/private-owner handoff, catching widened construction that could conceal a second dependency source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-227bc4333000c0c6",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-root-to-family-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds a root-owned value to a family invocation beyond its approved signature, testing the public composition tuple exactly.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra root-to-family argument"
    },
    {
      "id": "test-structure-coupling-8a5a2d44c9bdcb60",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-uninventoryed-live-private-owner-and-route-in-a-famil",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Introduces a working private owner and route that are absent from the canonical inventory, ensuring live but unnamed mutation paths remain rejected.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an uninventoryed live private owner and route in a family"
    },
    {
      "id": "test-structure-coupling-e0660606ecfc700b",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-family-to-private-owner-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Swaps two same-surface arguments at the private-owner call, a defect runtime smoke coverage may not distinguish until values diverge.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered family-to-private-owner arguments"
    },
    {
      "id": "test-structure-coupling-c91e07c5b311b838",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-reordered-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reorders the root arguments passed into one family registrar, preserving arity while violating ownership position.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects reordered root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-56c975daa7221e46",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-wrong-root-to-family-arguments",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Substitutes a different resolved dependency at the root/family edge, testing provenance rather than just argument count.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects wrong root-to-family arguments"
    },
    {
      "id": "test-structure-coupling-2c9a715e8123397b",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-conditional-private-owner-call-in-the-exported-family-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Wraps the presence private-owner invocation in a condition, making the exported family registrar unable to guarantee owner installation.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a conditional private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-72419b026769b6d0",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-after-the-handler-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Uses the canonical membership source as the comparison guard after relocating the correct handoff below the handler return.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only after the handler return"
    },
    {
      "id": "test-structure-coupling-2c9fc1d9749b84c8",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-a-literal-false-handler-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Compares the false-branch mutant with the original membership registrar so the assertion proves it tested unreachable rather than canonical source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in a literal-false handler branch"
    },
    {
      "id": "test-structure-coupling-d8cf0d32eadae715",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-correct-handoff-found-only-in-an-uninvoked-nested-hand",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Confirms the nested-function mutant differs from the membership source before requiring rejection of the never-invoked handoff.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a correct handoff found only in an uninvoked nested handler function"
    },
    {
      "id": "test-structure-coupling-4654f94f4e72070a",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-duplicate-private-owner-call-in-the-exported-family-re",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the private-owner setup inside the family registrar to enforce a single authoritative registration pass.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a duplicate private-owner call in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-22dc15575e2a1e4c",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-private-owner-call-after-a-family-registrar-return",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Places private-owner installation after the family registrar returns, distinguishing reachable construction from token presence.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a private-owner call after a family-registrar return"
    },
    {
      "id": "test-structure-coupling-15bbcd32e40bf76d",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-removed-private-owner-call-from-the-exported-family-re",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes the family’s only private-owner call, directly testing the missing handoff that would leave routes unowned.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a removed private-owner call from the exported family registrar"
    },
    {
      "id": "test-structure-coupling-2fc0acf2d10f5d4e",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-second-exact-registration-in-the-exported-family-regis",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds another exact route registration to the same family, guarding against ambiguous competing handlers.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a second exact registration in the exported family registrar"
    },
    {
      "id": "test-structure-coupling-f9b1590c42ac3d60",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-a-separately-bound-command-declared-after-its-submission",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves the separately bound command declaration below AppInbox submission, so the analyzer must reject use before authoritative construction.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects a separately bound command declared after its submission"
    },
    {
      "id": "test-structure-coupling-d32ceadfc6f25479",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-computed-result-object-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds a computed result property that overwrites the approved AppInbox type, exercising final object semantics rather than the first visible key.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a computed result-object property"
    },
    {
      "id": "test-structure-coupling-b7043c39e11a7834",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-appinbox-type-overridden-by-a-later-result-object-spr",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Appends a spread after the result type property so the effective AppInbox type can differ from the earlier literal.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an AppInbox type overridden by a later result-object spread"
    },
    {
      "id": "test-structure-coupling-1345f6386ce086d7",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-exact-registration-after-an-unconditional-owner-retur",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Moves the exact route registration below an unconditional owner return, making it dead despite remaining in the source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration after an unconditional owner return"
    },
    {
      "id": "test-structure-coupling-5fc76df120a41839",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-exact-registration-inside-a-literal-false-owner-branc",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Nests exact registration under a literal-false owner branch, testing reachability of the public route installation.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an exact registration inside a literal-false owner branch"
    },
    {
      "id": "test-structure-coupling-710b1ee889017354",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-computed-command-object-pro",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Overrides the command operation through a computed property, proving the audit evaluates the effective object value.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a computed command-object property"
    },
    {
      "id": "test-structure-coupling-19d9204dd60e1bc8",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-an-operation-overridden-by-a-later-command-object-spread",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Places an operation-changing spread after the approved command property, catching last-write-wins command drift.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects an operation overridden by a later command-object spread"
    },
    {
      "id": "test-structure-coupling-e341fd0365ad31ee",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-duplicate-direct-appinbox-type-properties-in-the-result-",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the direct result type property, rejecting an object whose authoritative outcome depends on property order.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct AppInbox type properties in the result object"
    },
    {
      "id": "test-structure-coupling-66383e1835cf7c4e",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-mutation-contract--rejects-duplicate-direct-operation-properties-in-the-command-obj",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Duplicates the command operation key, making the final submitted operation ambiguous to a source-only first-match check.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#rejects duplicate direct operation properties in the command object"
    },
    {
      "id": "test-structure-coupling-339457838dde3151",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--binds-direct-client-registrations-to-their-live-types",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the direct client registration collection and resolves each handler to the live type it actually installs.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#binds direct client registrations to their live types"
    },
    {
      "id": "test-structure-coupling-ec228fda47126f7e",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-missing-direct-topology-registration",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Rebinds one topology registration in the live owner and requires the audit to report the missing authoritative route.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct topology registration"
    },
    {
      "id": "test-structure-coupling-ac677f8aefd31dcf",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-missing-direct-crdt-registration",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Rebinds one CRDT registration in the live owner and requires the audit to report the missing authoritative route.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct CRDT registration"
    },
    {
      "id": "test-structure-coupling-8daaa2a7222a3e9c",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-an-auth-registration-loop-replaced-with-an-empty-iterabl",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Replaces the auth registrar’s live collection with an empty iterable, testing that a syntactically valid loop cannot mask total registration loss.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects an auth registration loop replaced with an empty iterable"
    },
    {
      "id": "test-structure-coupling-87348c819775b5e0",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-collections--rejects-a-missing-direct-group-registration",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Rebinds one group registration in the live owner and requires the audit to report that specific missing live route.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-collections.test.ts#rejects a missing direct group registration"
    },
    {
      "id": "test-structure-coupling-560101002d0a8a81",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--evaluates-safe-logical-includes-and-identity-map-chains-exactly",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration loop that the test replaces with a transparent filter/map chain before executing exact owner-coverage assertions.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#evaluates safe logical includes and identity map chains exactly"
    },
    {
      "id": "test-structure-coupling-cbc161a2abbae5c6",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--fails-closed-for-an-opaque-registration-predicate",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration expression that the test makes opaque before executing the analyzer and requiring unknown registration semantics to fail closed.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#fails closed for an opaque registration predicate"
    },
    {
      "id": "test-structure-coupling-2e15caeb35eae4be",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--narrows-the-auth-registration-array-with-an-exact-equality-filte",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration loop that the test narrows before executing the analyzer and requiring an excluded auth command to lose its owner connection.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#narrows the auth registration array with an exact equality filter"
    },
    {
      "id": "test-structure-coupling-4f6cf14c31fc65a6",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-registration-predicates--rejects-an-auth-registration-filter-that-is-always-false",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the live auth registration expression that the test replaces with false before executing the analyzer and requiring all auth owner connections to disappear.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-registration-predicates.test.ts#rejects an auth registration filter that is always false"
    },
    {
      "id": "test-structure-coupling-c6c21e820b68b8eb",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts",
      "kind": "production-source-read",
      "contract": "mutation-route-owner-crdt-reservation-materialization",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar repository maintainers",
      "rationale": "Reads the actual CRDT administrative mutation route as the mutated input to the real route validator, proving that disconnecting reservation construction from canonical AppInbox command materialization is rejected.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/mutation-route-owner-analysis.test.ts#rejects a CRDT reservation builder disconnected from command materialization"
    },
    {
      "id": "test-structure-coupling-5b530e925eb450cb",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-single-live-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The single-send count directly proves that one handled replay entry emits exactly one live delivery of the immutable outbox message.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#delivers the exact immutable outbox message when the publication is current"
    },
    {
      "id": "test-structure-coupling-f34d70bf4a6739c1",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-suppressed-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The send-absence assertion directly proves that an expired entry resolves to a typed retention gap without any live delivery.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#returns a typed retention gap without attempting a send"
    },
    {
      "id": "test-structure-coupling-7694279a835a985d",
      "path": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-topology-replay-corruption-suppressed-send",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar server maintainers",
      "rationale": "The send-absence assertion directly proves that corruption for a missing durable reference propagates without any live delivery.",
      "semanticCoverage": "packages/tests/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.test.ts#propagates corruption for a missing unexpired durable reference"
    },
    {
      "id": "test-structure-coupling-b3fa661d1e9850cc",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-connected-observer-delivery",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "One established callback is required for the one native connection transition; peer open state alone cannot detect duplicate observer effects.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#negotiates offers, forwards ICE candidates, and dispatches remote events"
    },
    {
      "id": "test-structure-coupling-036839b1702a8a0f",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-ice-restart-backoff-budget",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "The first retry deadline must produce one native ICE restart despite concurrent reconnect requests sharing that deadline.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#ignores offer collisions when impolite and retries with ICE restart on failure"
    },
    {
      "id": "test-structure-coupling-97e3c2ebcb7a5abc",
      "path": "packages/tests/shared/qrtc-peer-connection.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "rtc-ice-restart-backoff-budget",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "Five native restarts, followed by exhausted reset, proves the externally effective retry budget rather than only an internal attempt counter.",
      "semanticCoverage": "packages/tests/shared/qrtc-peer-connection.test.ts#ignores offer collisions when impolite and retries with ICE restart on failure"
    },
    {
      "id": "test-structure-coupling-298c5bb8d8655b3c",
      "path": "packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "room-send-membership-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Rallar realtime maintainers",
      "rationale": "Absence at the lane-opening port proves membership denial precedes transport work; the empty native send capture independently proves no frame escaped.",
      "semanticCoverage": "packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts#does not open or send for a room the current session has not joined"
    },
    {
      "id": "test-structure-coupling-e0edcf418c196587",
      "path": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-bridge-authentication-capability",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "A missing authentication capability must not start a full connection as a substitute, even if the bridge later rejects.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts#rejects missing authentication capability without starting a full connection"
    },
    {
      "id": "test-structure-coupling-7efeeba3a2a07e6e",
      "path": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-bridge-invalid-config-admission",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "The one allowed connect call distinguishes validation before side effects from a decoder that connects and then reports malformed input.",
      "semanticCoverage": "packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts#validates connection configuration before calling the native runtime"
    },
    {
      "id": "test-structure-coupling-9260348f27fc2039",
      "path": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-ws-subscription-resource-ownership",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "One acquisition for the repeated WS subscription key prevents duplicate message listeners and duplicate delivery.",
      "semanticCoverage": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts#deduplicates and disposes WS subscriptions while fencing stale leases"
    },
    {
      "id": "test-structure-coupling-ab8f03afb1e7940b",
      "path": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "browser-ws-subscription-resource-ownership",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Test maintainers",
      "rationale": "One invocation of the acquired unsubscribe disposer proves cleanup releases the shared subscription without repeating its side effect.",
      "semanticCoverage": "packages/tests/shared-test/rallar-browser-runtime-resource-controllers.test.ts#deduplicates and disposes WS subscriptions while fencing stale leases"
    },
    {
      "id": "test-structure-coupling-2587ac15f9ef4b7a",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "production-source-read",
      "contract": "group-http-translator-guard-reachability",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Reads the actual translator as executable analyzer input, preserving its real input-validation guards while testing an added statically unreachable throw. The test requires semantic route ownership to survive both inputs.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#accepts legitimate input rejection guards and an unreachable throwing branch"
    },
    {
      "id": "test-structure-coupling-cc1a11e1ef4e42a1",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts",
      "kind": "symbol-assertion",
      "contract": "group-http-translator-guard-reachability",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Asserts only that the source mutation actually changed the analyzer input before the semantic acceptance assertion. This prevents a vacuous passing security regression; it does not require any private symbol spelling, file size, or order.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-http-shapes.test.ts#accepts legitimate input rejection guards and an unreachable throwing branch"
    },
    {
      "id": "test-structure-coupling-8e81af49be0bf713",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-a-missing-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Removes one private-owner argument from a family call, proving the boundary tracks the complete dependency tuple.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects a missing family-to-private-owner argument"
    },
    {
      "id": "test-structure-coupling-29142dfe723974a7",
      "path": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts",
      "kind": "production-source-read",
      "contract": "group-mutation-construction--rejects-an-extra-family-to-private-owner-argument",
      "disposition": "durable-boundary",
      "boundary": "security",
      "owner": "Rallar server maintainers",
      "rationale": "Adds an unapproved argument at the family/private-owner handoff, catching widened construction that could conceal a second dependency source.",
      "semanticCoverage": "packages/tests/repo/mutation-route-ownership/route-owner/group/mutation-route-owner-group-construction.test.ts#rejects an extra family-to-private-owner argument"
    }
  ]
}
```
