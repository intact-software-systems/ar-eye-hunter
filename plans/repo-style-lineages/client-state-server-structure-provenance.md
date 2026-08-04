# Client-State Server Structure Provenance

Merge base: `39b2b7e6312507addfb4629c9d84ab476e83c362`

This inventory binds each complete command/validation target to exact,
possibly discontiguous merge-base regions. Source regions contain only the
symbols mechanically moved to that target. Target hashes cover the complete
module, so additions or ownership drift fail closed. Import-path glue, exported
owner modifiers, and type-only stage contracts are named exclusions and receive
no inherited warning capacity. File-level length warnings remain with the
transitional aggregate and are not assigned to these targets.

## Machine evidence

```text
mutation-contracts|packages/shared-server/rallar-system/services/client-state-mutations.ts|46-277|7f19b0e5519e912976f1eb14746d4922dc161e8351cea3ba969dd79446d4f88e|packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts|1|260|02b66466e91ba54cba22db0a9cccf4e1705f0504bcbd69fbead13c8a6e1694c1|import-path and exported-owner glue; no inherited capacity|boundary.unknown:ClientMutationCommand.metadata|inherited and accepted for PR A
validation-primitives|packages/shared-server/rallar-system/services/client-state-mutations.ts|292-300,2006-2171,2204-2221,2563-2567|f76bc3d3a03eebf750e73c8cfe1c1a99bfd7558da0f69c86f02b58358d9828a0|packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts|1|198|aa43354abe115288ccd0efea3d4b493f474d50370b8d3d5db27752c01125884f|import-path and exported-owner glue; no inherited capacity|function.input-contract:requireAllowedKeys;boundary.unknown:validation-boundary-parameters|inherited and accepted for PR A
command-root-facts-authority-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|302-317,2484-2561|c5c0c359d23367e59d40ba9b4ffb9b83b670f2b681252adc36cba9158915ecfb|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts|1|116|9e4f9509f18fad829d51654f7fc5ca9d09a2f90b449fc7b933dc5727cb06f3a5|private helper declarations; no inherited capacity|boundary.unknown:command-facts-authority-boundaries|inherited and accepted for PR A
operation-input-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|318-461,1838-1904,1957-2004,2173-2185,2198-2202|9ba310b97ce3e872fb249c2732b5c20c03b9b0143ed69cb73f8fb4e1f64a2a16|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts|1|332|472f4056d0f42801b2405a6ffc491d319ce639d8ad13cb53a5599314c0bedf41|type-only stage contract and helper declarations; no inherited capacity|boundary.unknown:generation-and-timestamp-boundaries|inherited and accepted for PR A
request-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|464-610,1905-1907,1935-2004,2173-2175,2187-2196|670497b39193256b5aab5757c0b67dce7b3ad52ae9cda1e0f8452f23119fe4a1|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts|1|266|57bc057bdcd17fb08fd8e375789de4055d8843ca6b97a26aeb3a4913d1ac7e0d|operation dispatcher and import-path glue; no inherited capacity|boundary.unknown:raw-request-and-timestamp-boundaries|inherited and accepted for PR A
command-projection-and-hashing|packages/shared-server/rallar-system/services/client-state-service.ts|310-330,374-582|165dc587e93b3a20227b9c394c4a9a240b80e2f876976d817c21811b5c924f3b|packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts|1|255|0f9c323a547537ae5d756cac16d81461527fa3e54986f4ca801edf30c62f5feb|import-path glue; no inherited capacity|function.input-contract:five-request-projections;function.output-contract:toExpiryCommandInput;function.output-contract:toActorInput|inherited and accepted for PR A
issued-and-system-authority-projection|packages/shared-server/rallar-system/services/client-mutation-authority.ts|1-37|c30b1b243bdc67d032fc5618f473b216bd5f2b06f53adfeeb5fdc8cc846be7ee|packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts|1|36|b8a5024710bd832d263c86aed9755f95f8e06110a6ef6a4257cc9d25367afdcf|import-path glue; no inherited capacity|none|inherited and accepted for PR A
expired-session-authority-validation|packages/shared-server/rallar-system/services/client-expired-state-authority.ts|1-27|6d63ede18e25f54194247900ec15e0ee18edc2d194688bd822e2d52681484240|packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts|1|31|3d2fb138ee44f5f8c360bf71df71067f83bcda7fb969deddc5821ea82f357c3c|import-path glue; no inherited capacity|boundary.unknown:liveSession|inherited and accepted for PR A
```

### mutation-contracts

- Source regions: `client-state-mutations.ts:46-277` (mutation command,
  computed, read, facts, receipt, and idempotency contracts).
- Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts`
  lines `1-260`.
- Findings: `boundary.unknown` remains owned by
  `ClientMutationCommand.metadata`; the aggregate source length warning did not
  move.

### validation-primitives

- Source regions: `client-state-mutations.ts:292-300,2006-2171,2204-2221,2563-2567`
  (rejection error, generic validation boundaries, principal-ref validation,
  and SHA-256 validation).
- Target: `packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts`
  lines `1-198`.
- Findings: inherited boundary-`unknown` parameters and the four-parameter
  `requireAllowedKeys` input-contract warning. `ClientValidationRecord` derives
  its type from `requirePlainRecord` and contributes no separate finding or
  inherited capacity.

### command-root-facts-authority-validation

- Source regions: `client-state-mutations.ts:302-317,2484-2561`.
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts`
  lines `1-116`.
- Findings: inherited `boundary.unknown` at command, facts, and authority
  validation boundaries. Operation-specific bodies are not assigned here.

### operation-input-validation

- Source regions: `client-state-mutations.ts:318-461,1838-1904,1957-2004,2173-2185,2198-2202`.
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts`
  lines `1-332`.
- Findings: inherited `boundary.unknown` at generation and timestamp validation
  boundaries. Persisted-key inventories at source lines `1908-1934` remain in
  the legacy persistence-validation owner and are excluded.

### request-validation

- Source regions: `client-state-mutations.ts:464-610,1905-1907,1935-2004,2173-2175,2187-2196`.
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts`
  lines `1-266`.
- Findings: inherited raw-request and timestamp `boundary.unknown` sites.
  Persisted-key inventories are not included.

### command-projection-and-hashing

- Source regions: `client-state-service.ts:310-330,374-582`.
- Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts`
  lines `1-255`.
- Findings: inherited input-contract warnings for the five public request
  projections and output-contract warnings for `toExpiryCommandInput` and
  `toActorInput`.
- The unmoved `requiresClientWrite`, `toClientMutationReceipt`, and
  `toClientStateWritten` region at source lines `332-372` is excluded.

### issued-and-system-authority-projection

- Source region: `client-mutation-authority.ts:1-37`.
- Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts`
  lines `1-36`.
- Findings: none; only import-path glue is excluded from inherited capacity.

### expired-session-authority-validation

- Source region: `client-expired-state-authority.ts:1-27`.
- Target: `packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts`
  lines `1-31`.
- Findings: inherited `boundary.unknown` on `liveSession`. The source-only long
  import line was reformatted and is not assigned to the target.

## Retained semantic-equality owner

Retained semantic-equality owner: `packages/shared-server/rallar-system/services/client-state-semantic-equality.ts:74-77`

The validation primitives import `isClientJsonObject` from this existing owner.
The former local predicate copy was removed; the type-only record alias derives
from the moved `requirePlainRecord` boundary and receives no inherited finding
capacity. This cohort does not move semantic-equality code. The merge-base owner blob is
`de169149cb606f9ba9009545a8efd2f50746688c`; its exact region hash is
`3cb57e0bb4be500115f8a7f051b819b8f18b76cf89de7e0322a8ea041c9570f8`.

## Compatibility files

The authority compatibility paths contain direct named one-hop exports. The
mixed service and mutation paths retain unmoved compute, result, persistence,
and service code for later cohorts while re-exporting moved public names from
their canonical owners.
