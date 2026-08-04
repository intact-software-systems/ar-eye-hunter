# Client-State Server Structure Provenance

Merge base: `39b2b7e6312507addfb4629c9d84ab476e83c362`

This inventory binds every complete PR A target to exact, possibly
discontiguous merge-base regions. Source regions contain only behavior or
contracts mechanically moved to that target. Whole-target hashes fail closed
for additions and ownership drift. Named imports, export modifiers, named-input
syntax, and behavior-neutral helper splits receive no historical warning
capacity. File-length findings remain with the transitional aggregate and are
never assigned to a target.

## Machine evidence

```text
mutation-contracts|packages/shared-server/rallar-system/services/client-state-mutations.ts|46-277|7f19b0e5519e912976f1eb14746d4922dc161e8351cea3ba969dd79446d4f88e|packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts|1|260|02b66466e91ba54cba22db0a9cccf4e1705f0504bcbd69fbead13c8a6e1694c1|import-path and exported-owner glue; no inherited capacity|boundary.unknown:ClientMutationCommand.metadata|inherited and accepted for PR A
validation-primitives|packages/shared-server/rallar-system/services/client-state-mutations.ts|292-300,2006-2171,2204-2221,2563-2567|f76bc3d3a03eebf750e73c8cfe1c1a99bfd7558da0f69c86f02b58358d9828a0|packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts|1|198|08531710fd0fc12424000a82b7ec9cecc1d1af8b447596e5df25442a9fbc2430|import-path and exported-owner glue; no inherited capacity|function.input-contract:requireAllowedKeys;boundary.unknown:validation-boundary-parameters|inherited and accepted for PR A
command-root-facts-authority-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|302-317,2484-2561|c5c0c359d23367e59d40ba9b4ffb9b83b670f2b681252adc36cba9158915ecfb|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts|1|116|c2f2e8382f42bf38e00741b20c68c6403638f28c5b0c780ff4225df1f575bf1f|private helper declarations; no inherited capacity|boundary.unknown:command-facts-authority-boundaries|inherited and accepted for PR A
operation-input-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|318-461,1838-1904,1957-2004,2173-2185,2198-2202|9ba310b97ce3e872fb249c2732b5c20c03b9b0143ed69cb73f8fb4e1f64a2a16|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts|1|332|472f4056d0f42801b2405a6ffc491d319ce639d8ad13cb53a5599314c0bedf41|type-only stage contract and helper declarations; no inherited capacity|boundary.unknown:generation-and-timestamp-boundaries|inherited and accepted for PR A
request-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|464-610,1905-1907,1935-2004,2173-2175,2187-2196|670497b39193256b5aab5757c0b67dce7b3ad52ae9cda1e0f8452f23119fe4a1|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts|1|266|57bc057bdcd17fb08fd8e375789de4055d8843ca6b97a26aeb3a4913d1ac7e0d|operation dispatcher and import-path glue; no inherited capacity|boundary.unknown:raw-request-and-timestamp-boundaries|inherited and accepted for PR A
command-projection-and-hashing|packages/shared-server/rallar-system/services/client-state-service.ts|310-330,374-582|165dc587e93b3a20227b9c394c4a9a240b80e2f876976d817c21811b5c924f3b|packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts|1|255|0f9c323a547537ae5d756cac16d81461527fa3e54986f4ca801edf30c62f5feb|import-path glue; no inherited capacity|function.input-contract:five-request-projections;function.output-contract:toExpiryCommandInput;function.output-contract:toActorInput|inherited and accepted for PR A
issued-and-system-authority-projection|packages/shared-server/rallar-system/services/client-mutation-authority.ts|1-37|c30b1b243bdc67d032fc5618f473b216bd5f2b06f53adfeeb5fdc8cc846be7ee|packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts|1|36|b8a5024710bd832d263c86aed9755f95f8e06110a6ef6a4257cc9d25367afdcf|import-path glue; no inherited capacity|none|inherited and accepted for PR A
expired-session-authority-validation|packages/shared-server/rallar-system/services/client-expired-state-authority.ts|1-27|6d63ede18e25f54194247900ec15e0ee18edc2d194688bd822e2d52681484240|packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts|1|31|3d2fb138ee44f5f8c360bf71df71067f83bcda7fb969deddc5821ea82f357c3c|import-path glue; no inherited capacity|boundary.unknown:liveSession|inherited and accepted for PR A
contract-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|2286-2298,2300-2352,2354-2387,2389-2456,2458-2470,2615-2641,2643-2665|a64cba7b899af9e3909c981a4b40ca527667e6e6d030120f2aec7e827b718257|packages/shared-server/rallar-system/client-state/client-state-contract-validation.ts|1|312|1b51d783ccc66326a07b7ae7ba481e3dccdef0320beec8b0c5b83a74b9bc861f|export modifiers, shared lower-level naming, and helper splits; no inherited capacity|boundary.unknown:client-contract-validation-boundaries|inherited and accepted for PR A
receipt-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|2569-2613,2673-2687|7fae0924ecd7c6f8c2fecb41f5dbd1e2d54ace352590497a00c1e0290fe4bb8c|packages/shared-server/rallar-system/client-state/client-mutation-receipt-validation.ts|1|104|536f6299c6311bdfa8a4c9c58a422f781f95033e4fdd5053d285eea9028b4389|export modifiers and receipt helper splits; no inherited capacity|boundary.unknown:receipt-idempotency-validation-boundaries|inherited and accepted for PR A
compute-dispatcher|packages/shared-server/rallar-system/services/client-state-mutations.ts|829-869|256ec4170894600acf4e18caed726614fb3a58544933e279d15112ac1c50239c|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts|1|57|df6b113477a7bd5f7ba06162fa4ba10ae7d86a5a6f106b490702ca7d5e869e79|direct family imports and named-input syntax; no inherited capacity|none|inherited and accepted for PR A
compute-principal|packages/shared-server/rallar-system/services/client-state-mutations.ts|1114-1126,1560-1604|eb1d38a8131efb03d88f6a9d4ff54ca46b4a00a0e954d6335df50d73c7538b9b|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-principal-mutation.ts|1|68|7deaf2326928077c3438b886f47bfbbffcd70fae242f7c0d2705e740f7845271|direct shared-owner imports and named-input syntax; no inherited capacity|none|inherited and accepted for PR A
compute-instance|packages/shared-server/rallar-system/services/client-state-mutations.ts|1128-1160,1634-1654|72375df0c9228203960fecf2a1f206dc3cabe39b549cdd39b6e1aaa0531243fa|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-instance-mutation.ts|1|76|eaa5e0f141e9b4e87fa29434120c23fede5e4777c7ccccf230c98946268a2ba1|direct shared-owner imports and named-input syntax; no inherited capacity|none|inherited and accepted for PR A
compute-connect|packages/shared-server/rallar-system/services/client-state-mutations.ts|1162-1227,1656-1713|514f63b579d38440deb3326b800772effd4bf92373349e3c531c231ba559189c|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-connect.ts|1|146|92c1c9c1c3573f6b57c5201740bf8801d0586db08022979c8f43f599ddf1299e|named generation tuple input and direct shared-owner imports; no inherited capacity|none|inherited and accepted for PR A
compute-heartbeat|packages/shared-server/rallar-system/services/client-state-mutations.ts|1229-1265|15a23796b150014c5b4a04824e1ea4d33ae88348b893a5a29361e8a8758aec18|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-heartbeat.ts|1|69|d0793acd84337646ca89b92234e88a84b4bd9d3424809a4f61a79e6493e67b89|direct shared-owner imports and named-input syntax; no inherited capacity|none|inherited and accepted for PR A
compute-disconnect|packages/shared-server/rallar-system/services/client-state-mutations.ts|1267-1311|7e521273d051f950fbc9967b865e85e97a9d6c3fbaae3c02fb1a869ec8fca93a|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-disconnect.ts|1|75|dbcbfd92977963490455c0bd2af47f2c5a383b246d382d3e984f014cc1ccf5a9|direct shared-owner imports and named-input syntax; no inherited capacity|none|inherited and accepted for PR A
compute-expiry|packages/shared-server/rallar-system/services/client-state-mutations.ts|1313-1345|610a77b7faa92b84464e4ce68b9f658d5e92a0ca0150d1af199547f66383f21d|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-expiry.ts|1|60|c95f2c07ce4cd5c6d00c4cb43e44ecf4996b0208b7774e900e52580285ed7339|current-session predicate extraction and named-input syntax; no inherited capacity|none|inherited and accepted for PR A
compute-result|packages/shared-server/rallar-system/services/client-state-mutations.ts|1347-1558,1738-1760|4b42483dafedeabb24a2f403afb02d3d6ce102228b519c97ef11622733836b47|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-result.ts|1|295|85033e6128a6dbb14123e4571d44767f209e928e1e9f4e149aa8b1515df91f38|named inputs and cohesive result-construction helpers; no inherited capacity|none|inherited and accepted for PR A
compute-state|packages/shared-server/rallar-system/services/client-state-mutations.ts|1606-1632,1715-1736,1762-1827|18b4f343a242df11e060ca7147c833a550f4a61cb470e4c6a2feb417019a6aaa|packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-state.ts|1|153|33bd000e8d2ca5f34617b4757ed79609a759647c4b73dac9160088869823d269|named inputs and cohesive state-construction helpers; no inherited capacity|none|inherited and accepted for PR A
validate-read|packages/shared-server/rallar-system/services/client-state-mutations.ts|980-1050,2472-2482|861b17a3f4f62fddd9ab07aeab24834596e38926d12feb317e84f3bd7f17908b|packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-read.ts|1|147|d42fe31e175fd7b77ee57914f4d4b53d2c5c2dc23368c7dca73d0ec44b7ef5ca|scope helper splits and direct lower-level validators; no inherited capacity|boundary.unknown:stable-read-boundaries|inherited and accepted for PR A
validate-authority|packages/shared-server/rallar-system/services/client-state-mutations.ts|1052-1112|cee562187dd364c49d63103de2edc4cb1f2564968f8633e3d8d8ead5f7e5a08f|packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts|1|81|281353107459c3953c344bac7df23594c6eb55c17aa1a993588a63841037a1b0|issued/system helper split; no inherited capacity|none|inherited and accepted for PR A
validate-result|packages/shared-server/rallar-system/services/client-state-mutations.ts|2689-2822|b5d996d67e215e268760658ada0ead7a5da3dc1f9d86fc8acd375b0dd1a926cd|packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-result.ts|1|173|19b52178577629a530d6dffa660e1e4d51a39ae4d6f561d1f893bd22b620bd4c|outcome helper splits and direct lower-level validators; no inherited capacity|boundary.unknown:computed-result-boundaries|inherited and accepted for PR A
validate-mutation|packages/shared-server/rallar-system/services/client-state-mutations.ts|278-290,871-978|3bd66b1df75122d124660e483ff707062c13736f0692bf652402cece4121a07e|packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts|1|202|8cd966558bb20dd4f27604831a3552f71425aa6f1500a4f084490ab0430b4cd5|named-input syntax and invariant helper splits; no inherited capacity|none|inherited and accepted for PR A
semantic-equality|packages/shared-server/rallar-system/services/client-state-semantic-equality.ts|1-78|5444cbd8ef4481fec91a9903636dcca82b3aca77fd9ae8042f39494d393de728|packages/shared-server/rallar-system/client-state/client-state-semantic-equality.ts|1|85|1db983c04c84dba69294243d60915432d6ac1b74488d1fd55cd4dc4fb67ddc55|canonical import path and formatting; no inherited capacity|boundary.unknown:json-semantic-equality|inherited and accepted for PR A
```

### mutation-contracts

Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts`

Exact mutation command, computed, read, facts, receipt, and idempotency
contracts moved from source lines `46-277`.

### validation-primitives

Target: `packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts`

Generic rejection, record, scalar, JSON, principal-ref, and digest primitives
moved from the recorded discontiguous regions.

### command-root-facts-authority-validation

Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts`

Command-root, persisted-fact, and authority validation moved without changing
validation order or messages.

### operation-input-validation

Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts`

Operation-specific command validation moved; persisted-key inventories remain
with the transitional persistence owner.

### request-validation

Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts`

Raw request and timestamp-order validation moved without widening accepted
input.

### command-projection-and-hashing

Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts`

Request projection and canonical hashing moved; the service result projection
region remains outside this target.

### issued-and-system-authority-projection

Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts`

Issued-session and system authority projection moved as one exact owner.

### expired-session-authority-validation

Target: `packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts`

Expired-session live/expired-entry authority validation moved unchanged.

### contract-validation

Target: `packages/shared-server/rallar-system/client-state/client-state-contract-validation.ts`

Entity, event, audit, actor, and runtime-entry validation moved to the shared
lower-level contract owner. Receipt and idempotency regions are excluded.

### receipt-validation

Target: `packages/shared-server/rallar-system/client-state/client-mutation-receipt-validation.ts`

Receipt and idempotency-record validation moved to their dedicated lower-level
owner; persisted normalization and wrapper identity checks remain in place.

### compute-dispatcher

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts`

Replay/conflict handling and the exhaustive operation switch moved to the
direct dispatcher.

### compute-principal

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-principal-mutation.ts`

Principal decision and projection moved to the named family owner.

### compute-instance

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-instance-mutation.ts`

Instance decision and projection moved to the named family owner.

### compute-connect

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-connect.ts`

Connect ordering, instance bootstrap, and active-session construction moved to
the named family owner.

### compute-heartbeat

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-heartbeat.ts`

Heartbeat decision and state transition moved to the named family owner.

### compute-disconnect

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-disconnect.ts`

Disconnect decision and terminal state transition moved to the named family
owner.

### compute-expiry

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-session-expiry.ts`

Expiry authority-state decision and terminal transition moved to the named
family owner.

### compute-result

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-result.ts`

No-op/applied results, snapshots, events, receipts, state-sync, and outbox
construction moved to one cohesive result owner.

### compute-state

Target: `packages/shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation-state.ts`

Shared audit, actor, default-principal, revision, required-state, and child
candidate construction moved to the private compute-state owner.

### validate-read

Target: `packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-read.ts`

Stable read shape, snapshot, event, scope, and idempotency validation moved to
the read-validation owner.

### validate-authority

Target: `packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts`

System and issued-session durable authority policy moved unchanged.

### validate-result

Target: `packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-result.ts`

Computed outcome and conditional-candidate structural validation moved to the
result-validation owner.

### validate-mutation

Target: `packages/shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts`

The idempotency conflict error and top-level post-compute invariants moved to
the canonical validation owner.

### semantic-equality

Target: `packages/shared-server/rallar-system/client-state/client-state-semantic-equality.ts`

The complete semantic equality owner moved from its exact merge-base blob.

## Canonical semantic-equality owner

Canonical semantic-equality owner: `packages/shared-server/rallar-system/client-state/client-state-semantic-equality.ts`

The validation primitives import `isClientJsonObject` directly from this owner.
The legacy service path is a direct named one-hop export. The source blob is
`de169149cb606f9ba9009545a8efd2f50746688c`; the original predicate at lines
`74-77` has region hash
`3cb57e0bb4be500115f8a7f051b819b8f18b76cf89de7e0322a8ea041c9570f8`.

## Compatibility and deferred persistence

Moved names remain direct named one-hop exports. The transitional
`services/client-state-mutations.ts` retains only current persistence
normalization, persisted-slot identity checks, and the exported persisted
idempotency wrapper for PR B. No persistence key, codec, repository, AppInbox,
transaction, retry, timing, or API-v1 behavior moved in this cohort.
