import type {
  GroupTopologyConfigPatch,
  GroupTopologyConfigView,
  GroupTopologyManagementView,
  ReconfigureGroupTopologyResponse,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
// prettier-ignore
import {
  GroupTopologyConfigMutationService,
} from './config/group-topology-config-mutation-service.ts';
import type {
  GroupTopologyConfigMutationAttemptRead,
  GroupTopologyConfigMutationPreparation,
} from './config/group-topology-config-mutation-service.ts';
import { GroupTopologyConfigQueryService } from './config/group-topology-config-query-service.ts';
// prettier-ignore
import {
  GroupTopologyConfigGenerationReadiness,
} from './config/maintenance/group-topology-config-generation-readiness.ts';
// prettier-ignore
import type * as mutationContracts
  from './config/mutation/group-topology-config-mutation-contracts.ts';
import {
  toTopologyConfigMutationResult,
  type GroupTopologyConfigMutationExecution,
} from './config/mutation/to-topology-config-mutation-result.ts';
import { writeTopologyConfigMutation } from './config/mutation/write-topology-config-mutation.ts';
import type {
  DeleteGroupTopologyConfigInput,
  DeleteGroupTopologyConfigResult,
  GroupTopologyManagementServiceOptions,
  PutGroupTopologyConfigInput,
  PutGroupTopologyConfigResult,
  PutGroupTopologyOverrideInput,
  PutGroupTopologyOverrideResult,
  ReconfigureGroupTopologyInput,
  ReconcileGroupTopologyResult,
} from './group-topology-management-contracts.ts';
// prettier-ignore
import type {
  GroupTopologyPlanningAuthority,
} from './planning/group-topology-planning-authority.ts';
import { GroupTopologyPlanningService } from './planning/group-topology-planning-service.ts';
import type {
  GroupTopologyReconfigureCommand,
  GroupTopologyReconfigureComputed,
  GroupTopologyReconfigureRead,
} from './reconfigure/group-topology-reconfigure-contracts.ts';
// prettier-ignore
import {
  GroupTopologyReconfigureMutation,
} from './reconfigure/group-topology-reconfigure-mutation.ts';

export * from './group-topology-errors.ts';
export type * from './group-topology-management-contracts.ts';
export type * from './planning/group-topology-planning-authority.ts';
export type * from './reconfigure/group-topology-reconfigure-contracts.ts';
// prettier-ignore
export type {
  GroupTopologyConfigMutationExecution,
} from './config/mutation/to-topology-config-mutation-result.ts';
export { writeTopologyConfigMutation } from './config/mutation/write-topology-config-mutation.ts';
export {
  createRtcOverlayTopologyBroadcastMessage,
  materializeRtcOverlayTopologyBroadcastMessage,
  type RtcOverlayTopologyMessageFacts,
} from './planning/materialize-rtc-overlay-topology-broadcast-message.ts';

export class GroupTopologyManagementService {
  readonly configMutationService: GroupTopologyConfigMutationService;
  readonly reconfigureMutation: GroupTopologyReconfigureMutation;

  private readonly options: GroupTopologyManagementServiceOptions;
  private readonly queryService: GroupTopologyConfigQueryService;
  private readonly planningService: GroupTopologyPlanningService;

  constructor(options: GroupTopologyManagementServiceOptions) {
    this.options = options;
    const readiness = new GroupTopologyConfigGenerationReadiness(
      options.configRepository,
      options.sleep,
    );
    this.queryService = new GroupTopologyConfigQueryService({
      findGroupSnapshotByRef: options.findGroupSnapshotByRef,
      readLocalTopologySnapshot: (group) => options.topologyService.readSnapshot(group),
      readPersistedTopologySnapshot: options.topologySnapshotRepository
        ? async (groupRef) => await options.topologySnapshotRepository?.findSnapshot(groupRef)
        : undefined,
      configRepository: options.configRepository,
      readiness,
      serverDefaults: options.serverDefaults,
    });
    this.planningService = new GroupTopologyPlanningService({
      findGroupSnapshotByRef: options.findGroupSnapshotByRef,
      queryService: this.queryService,
      topologyService: options.topologyService,
      groupStateRepository: options.groupStateRepository,
      rttRepository: options.rttRepository,
      processRttReader: options.processRttReader,
      publisher: options.publisher,
      serverDefaults: options.serverDefaults,
      persistentTopology: options.topologySnapshotRepository !== undefined,
    });
    this.configMutationService = new GroupTopologyConfigMutationService({
      readiness,
      configRepository: options.configRepository,
      groupStateRepository: options.groupStateRepository,
      serverDefaults: options.serverDefaults,
      nowEpochMs: options.now ?? (() => Date.now()),
      isPlatformAdmin: (principalId) => this.isPlatformAdmin(principalId),
    });
    this.reconfigureMutation = new GroupTopologyReconfigureMutation({
      groupStateRepository: options.groupStateRepository,
      readPlanningAuthority: async (groupRef, requestOptions, knownGroup) =>
        await this.planningService.readTopologyPlanningAuthority(
          groupRef,
          requestOptions,
          knownGroup,
        ),
      isPlatformAdmin: (principalId) => this.isPlatformAdmin(principalId),
    });
  }

  recordTopologyPublication(published: boolean): void {
    this.planningService.recordTopologyPublication(published);
  }

  recordTopologyRebuildSkippedFingerprint(): void {
    this.options.topologyService.recordTopologyRebuildSkippedFingerprint();
  }

  isPlatformAdmin(principalId: string): boolean {
    return this.options.adminPrincipalIds?.has(principalId) ?? false;
  }

  async readTopologyView(groupRef: GroupRef): Promise<GroupTopologyManagementView> {
    return await this.queryService.readTopologyView(groupRef);
  }

  async readConfig(groupRef: GroupRef): Promise<GroupTopologyConfigView> {
    return await this.queryService.readConfig(groupRef);
  }

  async readOverride(groupRef: GroupRef): Promise<StoredGroupTopologyOverride | undefined> {
    return await this.queryService.readOverride(groupRef);
  }

  /** @deprecated Submit mutations through AppGroupInboxService. */
  putConfig(input: PutGroupTopologyConfigInput): Promise<PutGroupTopologyConfigResult> {
    void input;
    return Promise.reject(new TypeError('Topology config writes require AppInbox execution'));
  }

  /** @deprecated Submit mutations through AppGroupInboxService. */
  deleteConfig(input: DeleteGroupTopologyConfigInput): Promise<DeleteGroupTopologyConfigResult> {
    void input;
    return Promise.reject(new TypeError('Topology config writes require AppInbox execution'));
  }

  /** @deprecated Submit mutations through AppGroupInboxService. */
  putOverride(input: PutGroupTopologyOverrideInput): Promise<PutGroupTopologyOverrideResult> {
    void input;
    return Promise.reject(new TypeError('Topology override writes require AppInbox execution'));
  }

  /** @deprecated Submit mutations through AppGroupInboxService. */
  deleteOverride(input: DeleteGroupTopologyConfigInput): Promise<DeleteGroupTopologyConfigResult> {
    void input;
    return Promise.reject(new TypeError('Topology override writes require AppInbox execution'));
  }

  async prepareTopologyConfigMutation(input: {
    readonly command: mutationContracts.GroupTopologyConfigMutationCommand;
    readonly commandHash: string;
    readonly capturedAtEpochMs: number;
  }): Promise<GroupTopologyConfigMutationPreparation> {
    return await this.configMutationService.prepare(input);
  }

  async readTopologyConfigMutation(
    command: mutationContracts.GroupTopologyConfigMutationCommand,
  ): Promise<GroupTopologyConfigMutationAttemptRead> {
    return await this.configMutationService.read(command);
  }

  computeTopologyConfigMutation(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
  ): mutationContracts.GroupTopologyConfigMutationComputed {
    return this.configMutationService.compute(preparation, read, attemptCount);
  }

  validateTopologyConfigMutation(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
    computed: mutationContracts.GroupTopologyConfigMutationComputed,
  ): void {
    this.configMutationService.validate(preparation, read, attemptCount, computed);
  }

  async writeTopologyConfigMutation(
    transaction: PSqlTransactionSql,
    computed: Extract<
      mutationContracts.GroupTopologyConfigMutationComputed,
      { outcome: 'write' | 'claim' }
    >,
  ): Promise<mutationContracts.GroupTopologyConfigMutationReceipt> {
    return await writeTopologyConfigMutation(transaction, computed);
  }

  toTopologyConfigMutationResult(
    computed: Exclude<
      mutationContracts.GroupTopologyConfigMutationComputed,
      { outcome: 'idempotency-conflict' }
    >,
  ): GroupTopologyConfigMutationExecution {
    return toTopologyConfigMutationResult(computed);
  }

  async readTopologyMutation(
    command: GroupTopologyReconfigureCommand,
  ): Promise<GroupTopologyReconfigureRead> {
    return await this.reconfigureMutation.read(command);
  }

  computeTopologyMutation(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
  ): GroupTopologyReconfigureComputed {
    return this.reconfigureMutation.compute(command, read);
  }

  validateTopologyMutation(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
    computed: GroupTopologyReconfigureComputed,
  ): void {
    this.reconfigureMutation.validate(command, read, computed);
  }

  async writeTopologyMutation(
    transaction: PSqlTransactionSql,
    computed: GroupTopologyReconfigureComputed,
  ): Promise<void> {
    await this.reconfigureMutation.write(transaction, computed);
  }

  async reconfigureGroupTopology(
    input: ReconfigureGroupTopologyInput,
  ): Promise<ReconfigureGroupTopologyResponse> {
    return await this.planningService.reconfigureGroupTopology(input);
  }

  async reconcileGroupTopology(group: GroupSnapshot): Promise<ReconcileGroupTopologyResult> {
    return await this.planningService.reconcileGroupTopology(group);
  }

  async computeGroupTopology(
    group: GroupSnapshot,
    previous: RallarOverlayTopologySnapshot | undefined,
  ): Promise<ReconcileGroupTopologyResult> {
    return await this.planningService.computeGroupTopology(group, previous);
  }

  /** @deprecated Use computeGroupTopology. */
  async planGroupTopology(
    group: GroupSnapshot,
    previous: RallarOverlayTopologySnapshot | undefined,
  ): Promise<ReconcileGroupTopologyResult> {
    return await this.computeGroupTopology(group, previous);
  }

  async readTopologyPlanningAuthority(
    groupRef: GroupRef,
    requestOptions?: GroupTopologyConfigPatch,
    knownGroup?: GroupSnapshot,
    useKnownGroupRevision = false,
  ): Promise<GroupTopologyPlanningAuthority> {
    return await this.planningService.readTopologyPlanningAuthority(
      groupRef,
      requestOptions,
      knownGroup,
      useKnownGroupRevision,
    );
  }

  computeTopologyFromAuthority(
    authority: GroupTopologyPlanningAuthority,
    previous: RallarOverlayTopologySnapshot | undefined,
  ): ReconcileGroupTopologyResult {
    return this.planningService.computeTopologyFromAuthority(authority, previous);
  }

  /** @deprecated Use computeTopologyFromAuthority. */
  planTopologyFromAuthority(
    authority: GroupTopologyPlanningAuthority,
    previous: RallarOverlayTopologySnapshot | undefined,
  ): ReconcileGroupTopologyResult {
    return this.computeTopologyFromAuthority(authority, previous);
  }

  async findCurrentGroupSnapshot(groupRef: GroupRef): Promise<GroupSnapshot> {
    return await this.queryService.findCurrentGroupSnapshot(groupRef);
  }

  observeCommittedTopology(group: GroupSnapshot, snapshot: RallarOverlayTopologySnapshot): void {
    this.planningService.observeCommittedTopology(group, snapshot);
  }

  async flushDueGroupTopology(
    input: ReconfigureGroupTopologyInput,
  ): Promise<ReconfigureGroupTopologyResponse | undefined> {
    return await this.planningService.flushDueGroupTopology(input);
  }

  removeGroupTopology(group: GroupSnapshot): Promise<void> {
    return this.planningService.removeGroupTopology(group);
  }
}

export function requireTopologyManagementService(
  service: GroupTopologyManagementService | undefined,
): GroupTopologyManagementService {
  if (!service) {
    throw new TypeError('Topology management service is not configured');
  }
  return service;
}
