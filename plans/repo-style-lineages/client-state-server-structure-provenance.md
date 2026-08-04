# Client-State Server Structure Provenance

Merge base: `39b2b7e6312507addfb4629c9d84ab476e83c362`

This inventory binds only mechanically moved PR A command/validation regions
to the approved source blobs. Each target hash covers the complete target
module so unreviewed semantic additions fail closed. The source ranges are
inclusive, one-based lines from the recorded merge base. Every listed finding
is inherited and accepted for PR A; later warning alignment remains outside
this cohort.

## Machine evidence

```text
mutation-contracts|client-mutation-contracts.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|46|277|7f19b0e5519e912976f1eb14746d4922dc161e8351cea3ba969dd79446d4f88e|packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts|1|260|02b66466e91ba54cba22db0a9cccf4e1705f0504bcbd69fbead13c8a6e1694c1|file.length;boundary.unknown at line 105|inherited and accepted for PR A
rejection-error|client-state-validation-primitives.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|292|300|4e577da1c2a9d116c8fafbfeae6edfc4ceb2fd1191523e2d06a602b1a8967700|packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts|1|197|19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a|file.length|inherited and accepted for PR A
command-validation|validate-client-mutation-command.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|302|463|8bd1da90612e8924a10e2cf4957902c98cd903dacfa50b8d011a68d2eeb5dbcc|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts|1|116|9e4f9509f18fad829d51654f7fc5ca9d09a2f90b449fc7b933dc5727cb06f3a5|boundary.unknown at line 303|inherited and accepted for PR A
request-validation|validate-client-mutation-request.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|464|611|239fe4241eb3529f3e2da594ae89fcf61f1c4752bdbb43d22e0129510f65ad81|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts|1|266|57bc057bdcd17fb08fd8e375789de4055d8843ca6b97a26aeb3a4913d1ac7e0d|boundary.unknown raw request overloads|inherited and accepted for PR A
operation-input-constants-and-ordering|validate-client-mutation-operation-input.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|1838|2005|1f71c1b37828aec1e619b8fd1140411b4ea7e57d91d179534647db1007cbf69e|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts|1|332|472f4056d0f42801b2405a6ffc491d319ce639d8ad13cb53a5599314c0bedf41|file.length|inherited and accepted for PR A
generic-validation-primitives|client-state-validation-primitives.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|2006|2172|0a826017179db265730ec6d62ad4bccfd634efb9cffcf2801b3ce235b12beb40|packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts|1|197|19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a|function.input-contract requireAllowedKeys at line 2038|inherited and accepted for PR A
operation-input-actor-and-root-validation|validate-client-mutation-operation-input.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|2173|2202|49b1b065e329c727147fc555c1df3b9d4025965ef46780742fc081dfda3e976e|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts|1|332|472f4056d0f42801b2405a6ffc491d319ce639d8ad13cb53a5599314c0bedf41|file.length|inherited and accepted for PR A
principal-reference-primitive|client-state-validation-primitives.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|2204|2221|f84a2f4822458118588e12e70ab1eb7c8f698fe4bf46768f166a7716fcc225cf|packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts|1|197|19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a|file.length|inherited and accepted for PR A
command-facts-and-authority-validation|validate-client-mutation-command.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|2484|2562|dbce3c9d4dbfd97477ce212e279ca5a3e8daf8523591a1ba8b4ece5d54eff474|packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts|1|116|9e4f9509f18fad829d51654f7fc5ca9d09a2f90b449fc7b933dc5727cb06f3a5|file.length|inherited and accepted for PR A
sha256-validation-primitive|client-state-validation-primitives.ts|packages/shared-server/rallar-system/services/client-state-mutations.ts|2563|2567|2f537053593c5724b558e98c81f20dbce5f63f73314e5d8bc887f6b8135aa931|packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts|1|197|19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a|file.length|inherited and accepted for PR A
command-projection-and-hashing|client-mutation-command.ts|packages/shared-server/rallar-system/services/client-state-service.ts|310|583|cb972e44bb217a6e66e42fdb2b0b5f9230debb46ffc6edf31b46bf16e1618bf6|packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts|1|255|0f9c323a547537ae5d756cac16d81461527fa3e54986f4ca801edf30c62f5feb|function.input-contract projection family|inherited and accepted for PR A
issued-and-system-authority-projection|client-mutation-authority.ts|packages/shared-server/rallar-system/services/client-mutation-authority.ts|1|37|c30b1b243bdc67d032fc5618f473b216bd5f2b06f53adfeeb5fdc8cc846be7ee|packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts|1|36|b8a5024710bd832d263c86aed9755f95f8e06110a6ef6a4257cc9d25367afdcf|mechanical owner move|inherited and accepted for PR A
expired-session-authority-validation|validate-client-expired-session-authority.ts|packages/shared-server/rallar-system/services/client-expired-state-authority.ts|1|27|6d63ede18e25f54194247900ec15e0ee18edc2d194688bd822e2d52681484240|packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts|1|31|3d2fb138ee44f5f8c360bf71df71067f83bcda7fb969deddc5821ea82f357c3c|line.width at line 3;boundary.unknown at line 10|inherited and accepted for PR A
```

### mutation-contracts

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:46-277`
- Source hash: `7f19b0e5519e912976f1eb14746d4922dc161e8351cea3ba969dd79446d4f88e`
- Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts`
- Target hash: `02b66466e91ba54cba22db0a9cccf4e1705f0504bcbd69fbead13c8a6e1694c1`
- Findings: `file.length`; `boundary.unknown at line 105`

### rejection-error

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:292-300`
- Source hash: `4e577da1c2a9d116c8fafbfeae6edfc4ceb2fd1191523e2d06a602b1a8967700`
- Target: `packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts`
- Target hash: `19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a`
- Findings: `file.length`

### command-validation

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:302-463`
- Source hash: `8bd1da90612e8924a10e2cf4957902c98cd903dacfa50b8d011a68d2eeb5dbcc`
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts`
- Target hash: `9e4f9509f18fad829d51654f7fc5ca9d09a2f90b449fc7b933dc5727cb06f3a5`
- Findings: `boundary.unknown at line 303`

### request-validation

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:464-611`
- Source hash: `239fe4241eb3529f3e2da594ae89fcf61f1c4752bdbb43d22e0129510f65ad81`
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts`
- Target hash: `57bc057bdcd17fb08fd8e375789de4055d8843ca6b97a26aeb3a4913d1ac7e0d`
- Findings: inherited raw-request `boundary.unknown` sites

### operation-input-constants-and-ordering

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:1838-2005`
- Source hash: `1f71c1b37828aec1e619b8fd1140411b4ea7e57d91d179534647db1007cbf69e`
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts`
- Target hash: `472f4056d0f42801b2405a6ffc491d319ce639d8ad13cb53a5599314c0bedf41`
- Findings: `file.length`

### generic-validation-primitives

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:2006-2172`
- Source hash: `0a826017179db265730ec6d62ad4bccfd634efb9cffcf2801b3ce235b12beb40`
- Target: `packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts`
- Target hash: `19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a`
- Findings: `function.input-contract requireAllowedKeys at line 2038`

### operation-input-actor-and-root-validation

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:2173-2202`
- Source hash: `49b1b065e329c727147fc555c1df3b9d4025965ef46780742fc081dfda3e976e`
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts`
- Target hash: `472f4056d0f42801b2405a6ffc491d319ce639d8ad13cb53a5599314c0bedf41`
- Findings: `file.length`

### principal-reference-primitive

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:2204-2221`
- Source hash: `f84a2f4822458118588e12e70ab1eb7c8f698fe4bf46768f166a7716fcc225cf`
- Target: `packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts`
- Target hash: `19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a`
- Findings: `file.length`

### command-facts-and-authority-validation

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:2484-2562`
- Source hash: `dbce3c9d4dbfd97477ce212e279ca5a3e8daf8523591a1ba8b4ece5d54eff474`
- Target: `packages/shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts`
- Target hash: `9e4f9509f18fad829d51654f7fc5ca9d09a2f90b449fc7b933dc5727cb06f3a5`
- Findings: `file.length`

### sha256-validation-primitive

- Source: `packages/shared-server/rallar-system/services/client-state-mutations.ts:2563-2567`
- Source hash: `2f537053593c5724b558e98c81f20dbce5f63f73314e5d8bc887f6b8135aa931`
- Target: `packages/shared-server/rallar-system/client-state/client-state-validation-primitives.ts`
- Target hash: `19c14d2de1d4ee315cd29deb4a1b9698b6906e49d545850d60b0ffae8717780a`
- Findings: `file.length`

### command-projection-and-hashing

- Source: `packages/shared-server/rallar-system/services/client-state-service.ts:310-583`
- Source hash: `cb972e44bb217a6e66e42fdb2b0b5f9230debb46ffc6edf31b46bf16e1618bf6`
- Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-command.ts`
- Target hash: `0f9c323a547537ae5d756cac16d81461527fa3e54986f4ca801edf30c62f5feb`
- Findings: inherited `function.input-contract` findings for the five public request projections
- Scope correction: the approved worksheet assigned these functions to PR B,
  but the tracked plan and Task 2 dispatch assign request/payload projection and
  hashing to PR A. Signatures remain unchanged; alignment is deferred.

### issued-and-system-authority-projection

- Source: `packages/shared-server/rallar-system/services/client-mutation-authority.ts:1-37`
- Source hash: `c30b1b243bdc67d032fc5618f473b216bd5f2b06f53adfeeb5fdc8cc846be7ee`
- Target: `packages/shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts`
- Target hash: `b8a5024710bd832d263c86aed9755f95f8e06110a6ef6a4257cc9d25367afdcf`
- Findings: mechanical owner move

### expired-session-authority-validation

- Source: `packages/shared-server/rallar-system/services/client-expired-state-authority.ts:1-27`
- Source hash: `6d63ede18e25f54194247900ec15e0ee18edc2d194688bd822e2d52681484240`
- Target: `packages/shared-server/rallar-system/client-state/mutation/validate-client-expired-session-authority.ts`
- Target hash: `3d2fb138ee44f5f8c360bf71df71067f83bcda7fb969deddc5821ea82f357c3c`
- Findings: `line.width at line 3`; `boundary.unknown at line 10`

## Compatibility files

The authority compatibility paths contain only direct named one-hop exports.
The mixed service and mutation paths retain unmoved compute/result/service code
for later cohorts while re-exporting the moved public names directly from their
canonical owners.
