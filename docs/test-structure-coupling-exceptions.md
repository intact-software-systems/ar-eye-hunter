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
      "id": "shared-web-remote-media-attachment-lifecycle",
      "domain": "Shared-web remote media attachment lifecycle",
      "owner": "Shared Web maintainers",
      "summary": "Remote-media registration waits for connection attachment. Executable assertion: “owns middleware registration from connection attach through final unsubscribe”.",
      "semanticCoverage": "packages/tests/shared-web/media/browser-remote-media-stream-runtime.test.ts#owns middleware registration from connection attach through final unsubscribe",
      "coverageRelation": "The named assertion executes this lifecycle and observes its owned side-effect port; the registered evidence directly proves the stated constraint.",
      "interactionRequirement": {
        "interactionKind": "absence",
        "ownedPort": "RTC remote-stream middleware registration port",
        "observableEffect": "Subscribing before attachment does not register against an unavailable connection.",
        "requiredConstraint": "The registration port remains unused until attach supplies middleware.",
        "failureRationale": "Early registration binds to missing or stale connection state."
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
    }
  ],
  "entries": [
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
      "id": "test-structure-coupling-bed585f360e5499b",
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
      "id": "test-structure-coupling-fb9c9389cdd8634a",
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
      "contract": "recipe-matrix-public-interface--uses-rallar-signaling-for-signaling-recipe-examples-and-keeps-on",
      "disposition": "durable-boundary",
      "boundary": "public",
      "owner": "Shared Test maintainers",
      "rationale": "Loads the designated legacy alias fixture separately so the catalog can require rallar-signaling everywhere else without deleting compatibility evidence.",
      "semanticCoverage": "packages/tests/shared-test/recipe-matrix.test.ts#uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture"
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
      "id": "test-structure-coupling-a90a04906ba9c761",
      "path": "packages/tests/shared-web/media/browser-remote-media-stream-runtime.test.ts",
      "kind": "mock-invocation-count-or-order",
      "contract": "shared-web-remote-media-attachment-lifecycle",
      "disposition": "durable-boundary",
      "boundary": "interaction",
      "owner": "Shared Web maintainers",
      "rationale": "The pre-attach registration absence assertion directly proves that registration remains unused until middleware attachment.",
      "semanticCoverage": "packages/tests/shared-web/media/browser-remote-media-stream-runtime.test.ts#owns middleware registration from connection attach through final unsubscribe"
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
    }
  ]
}
```
