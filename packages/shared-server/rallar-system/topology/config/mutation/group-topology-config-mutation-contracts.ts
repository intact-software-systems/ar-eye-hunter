import type {
  GroupTopologyConfigMutationOperation,
  GroupTopologyConfigMutationReceipt,
  GroupTopologyConfigPatch,
  StoredGroupTopologyConfig,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
// prettier-ignore
import type * as persistence
  from '../../../group-state/persistence/group-state-persistence-contracts.ts';
import type { GroupTopologyServerOptions } from '../group-topology-config.ts';
import type { ComputedRtcTopologyOutbox } from '../../../services/rtc-topology-outbox-entry.ts';

export type {
  GroupTopologyConfigMutationOperation,
  GroupTopologyConfigMutationReceipt,
} from '@shared/api/graph-topology-management-types.ts';

export interface GroupTopologyConfigMutationCommand {
  readonly operation: GroupTopologyConfigMutationOperation;
  readonly aggregateRef: GroupRef;
  readonly commandId: string;
  readonly requestId: string | null;
  readonly input: Readonly<{
    config: GroupTopologyConfigPatch | null;
    updatedByPrincipalId: string;
    ttlMs: number | null;
    expiresAtEpochMs: number | null;
  }>;
}

export interface GroupTopologyConfigMutationRecord {
  readonly groupRef: GroupRef;
  readonly requestId: string;
  readonly commandHash: string;
  readonly receipt: GroupTopologyConfigMutationReceipt;
}

export type GroupTopologyConfigMutationAcceptedResult =
  | Readonly<{ kind: 'config'; config: StoredGroupTopologyConfig }>
  | Readonly<{ kind: 'override'; override: StoredGroupTopologyOverride }>
  | Readonly<{ kind: 'delete'; deleted: boolean }>;

export type GroupTopologyConfigGenerationTarget = 'config' | 'override';

export interface GroupTopologyConfigGeneration {
  readonly groupRef: GroupRef;
  readonly target: GroupTopologyConfigGenerationTarget;
  readonly version: number;
}

export interface GroupTopologyConfigInvariantGeneration {
  readonly groupRef: GroupRef;
  readonly version: number;
}

export interface GroupTopologyConfigMutationRead {
  readonly config: RuntimeStateEntryValue<StoredGroupTopologyConfig> | null;
  readonly override: RuntimeStateEntryValue<StoredGroupTopologyOverride> | null;
  readonly configGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
  readonly overrideGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
  readonly invariantGeneration: TopologyConfigInvariantGenerationEntry | null;
  readonly idempotency: RuntimeStateEntryValue<GroupTopologyConfigMutationRecord> | null;
  readonly groupSnapshot: GroupSnapshot;
  readonly groupAuthorityGuard: persistence.GroupStateAuthorityGuard;
}

type TopologyConfigInvariantGenerationEntry =
  RuntimeStateEntryValue<GroupTopologyConfigInvariantGeneration>;

export interface GroupTopologyConfigMutationStableFacts {
  readonly requestedAtEpochMs: number;
  readonly commandHash: string;
  readonly resolvedOverrideExpiresAtEpochMs: number | null;
}

export interface GroupTopologyConfigMutationFacts extends GroupTopologyConfigMutationStableFacts {
  readonly isPlatformAdmin: boolean;
  readonly policyNowEpochMs: number;
  readonly attemptCount: number;
}

export type GroupTopologyConfigOutboxInput = ComputedRtcTopologyOutbox;

export type TopologyConfigWriteGuard =
  | Readonly<{
      target: 'config';
      operation: 'insert' | 'update';
      expectedRevision: number | null;
      value: StoredGroupTopologyConfig;
    }>
  | Readonly<{
      target: 'config';
      operation: 'delete';
      expectedRevision: number;
      value: null;
    }>
  | Readonly<{
      target: 'override';
      operation: 'insert' | 'update';
      expectedRevision: number | null;
      value: StoredGroupTopologyOverride;
    }>
  | Readonly<{
      target: 'override';
      operation: 'delete';
      expectedRevision: number;
      value: null;
    }>;

export interface TopologyConfigGenerationGuard {
  readonly expectedRevision: number | null;
  readonly value: GroupTopologyConfigGeneration;
}

export interface TopologyConfigInvariantGenerationGuard {
  readonly expectedRevision: number | null;
  readonly value: GroupTopologyConfigInvariantGeneration;
}

export interface GroupTopologyConfigMutationWriteComputed {
  readonly outcome: 'write';
  readonly groupAuthorityGuard: persistence.GroupStateAuthorityGuard;
  readonly guard: TopologyConfigWriteGuard;
  readonly invariantGenerationGuard: TopologyConfigInvariantGenerationGuard;
  readonly generationGuard: TopologyConfigGenerationGuard;
  readonly receipt: GroupTopologyConfigMutationReceipt;
  readonly idempotency: GroupTopologyConfigMutationRecord | null;
  readonly outbox: GroupTopologyConfigOutboxInput;
  readonly result: GroupTopologyConfigMutationAcceptedResult;
}

export type GroupTopologyConfigMutationComputed =
  | GroupTopologyConfigMutationWriteComputed
  | Readonly<{
      outcome: 'claim';
      groupAuthorityGuard: persistence.GroupStateAuthorityGuard;
      receipt: GroupTopologyConfigMutationReceipt;
      idempotency: GroupTopologyConfigMutationRecord;
      result: GroupTopologyConfigMutationAcceptedResult;
    }>
  | Readonly<{
      outcome: 'no-op';
      receipt: GroupTopologyConfigMutationReceipt;
      result: GroupTopologyConfigMutationAcceptedResult;
    }>
  | Readonly<{
      outcome: 'replay';
      receipt: GroupTopologyConfigMutationReceipt;
      result: GroupTopologyConfigMutationAcceptedResult;
    }>
  | Readonly<{
      outcome: 'idempotency-conflict';
      existingCommandHash: string;
      receivedCommandHash: string;
    }>;

export interface TopologyConfigMutationInput {
  readonly command: GroupTopologyConfigMutationCommand;
  readonly read: GroupTopologyConfigMutationRead;
  readonly facts: GroupTopologyConfigMutationFacts;
  readonly serverDefaults: GroupTopologyServerOptions;
}
