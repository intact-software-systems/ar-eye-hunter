import type {
  GroupTopologyConfigPatch,
  GroupTopologyConfigView,
  GroupTopologyManagementView,
  ReconfigureGroupTopologyResponse,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import * as processRttRepository from '@shared/repository/rtt-repository.ts';

import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { GroupTopologyConfigMutationService } from './config/group-topology-config-mutation-service.ts';
import type {
  GroupTopologyConfigMutationAttemptRead,
  GroupTopologyConfigMutationPreparation,
} from './config/group-topology-config-mutation-service.ts';
import { GroupTopologyConfigQueryService } from './config/group-topology-config-query-service.ts';
import { GroupTopologyConfigGenerationReadiness } from './config/maintenance/group-topology-config-generation-readiness.ts';
import type * as mutationContracts from './config/mutation/group-topology-config-mutation-contracts.ts';
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
import type { GroupTopologyPlanningAuthority } from './planning/group-topology-planning-authority.ts';
import {
  GroupTopologyPlanningService,
  type GroupTopologyPlanningServiceDependencies,
} from './planning/group-topology-planning-service.ts';
import type {
  GroupTopologyReconfigureCommand,
  GroupTopologyReconfigureComputed,
  GroupTopologyReconfigureRead,
} from './reconfigure/group-topology-reconfigure-contracts.ts';
import { GroupTopologyReconfigureMutation } from './reconfigure/group-topology-reconfigure-mutation.ts';

export * from './group-topology-errors.ts';
export type * from './group-topology-management-contracts.ts';
export type * from './planning/group-topology-planning-authority.ts';
export type * from './reconfigure/group-topology-reconfigure-contracts.ts';
export type { GroupTopologyConfigMutationExecution } from './config/mutation/to-topology-config-mutation-result.ts';
export { writeTopologyConfigMutation } from './config/mutation/write-topology-config-mutation.ts';
export {
  createRtcOverlayTopologyBroadcastMessage,
  materializeRtcOverlayTopologyBroadcastMessage,
  type RtcOverlayTopologyMessageFacts,
} from './planning/materialize-rtc-overlay-topology-broadcast-message.ts';

export class GroupTopologyManagementService {
  readonly configMutationService: GroupTopologyConfigMutationService | undefined;
  readonly reconfigureMutation: GroupTopologyReconfigureMutation | undefined;
  readonly planningService: GroupTopologyPlanningService;

  private readonly options: GroupTopologyManagementServiceOptions;
  private readonly queryService: GroupTopologyConfigQueryService;

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
      readCurrentGroupSnapshot: createTopologyPlanningSnapshotReader(options, this.queryService),
      readRttMeasurements: createTopologyPlanningRttReader(options),
      topologyMode: options.topologySnapshotRepository ? 'persistent' : 'local',
      publisher: options.publisher,
      serverDefaults: options.serverDefaults,
    });
    this.configMutationService =
      options.configRepository && options.groupStateRepository
        ? new GroupTopologyConfigMutationService({
            readiness,
            configRepository: options.configRepository,
            groupStateRepository: options.groupStateRepository,
            serverDefaults: options.serverDefaults,
            nowEpochMs: options.now ?? (() => Date.now()),
            isPlatformAdmin: (principalId) => this.isPlatformAdmin(principalId),
          })
        : undefined;
    this.reconfigureMutation = options.groupStateRepository
      ? new GroupTopologyReconfigureMutation({
          groupStateRepository: options.groupStateRepository,
          readPlanningAuthority: async (input) =>
            await this.planningService.readTopologyPlanningAuthority(input),
          isPlatformAdmin: (principalId) => this.isPlatformAdmin(principalId),
        })
      : undefined;
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
    return await this.requireConfigMutationService().prepare(input);
  }

  async readTopologyConfigMutation(
    command: mutationContracts.GroupTopologyConfigMutationCommand,
  ): Promise<GroupTopologyConfigMutationAttemptRead> {
    return await this.requireConfigMutationService().read(command);
  }

  computeTopologyConfigMutation(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
  ): mutationContracts.GroupTopologyConfigMutationComputed {
    return this.requireConfigMutationService().compute(preparation, read, attemptCount);
  }

  validateTopologyConfigMutation(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
    computed: mutationContracts.GroupTopologyConfigMutationComputed,
  ): void {
    this.requireConfigMutationService().validate(preparation, read, attemptCount, computed);
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
    return await this.requireReconfigureMutation().read(command);
  }

  computeTopologyMutation(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
  ): GroupTopologyReconfigureComputed {
    return this.requireReconfigureMutation().compute(command, read);
  }

  validateTopologyMutation(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
    computed: GroupTopologyReconfigureComputed,
  ): void {
    this.requireReconfigureMutation().validate(command, read, computed);
  }

  async writeTopologyMutation(
    transaction: PSqlTransactionSql,
    computed: GroupTopologyReconfigureComputed,
  ): Promise<void> {
    await this.requireReconfigureMutation().write(transaction, computed);
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
    return await this.planningService.readTopologyPlanningAuthority({
      groupRef,
      requestOptions,
      knownGroup,
      snapshotSelection: useKnownGroupRevision ? 'preserve-known-revision' : 'prefer-current',
    });
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

  private requireConfigMutationService(): GroupTopologyConfigMutationService {
    if (!this.configMutationService) {
      throw new TypeError('Topology config mutation owner is not configured');
    }
    return this.configMutationService;
  }

  private requireReconfigureMutation(): GroupTopologyReconfigureMutation {
    if (!this.reconfigureMutation) {
      throw new TypeError('Topology reconfigure mutation owner is not configured');
    }
    return this.reconfigureMutation;
  }
}

function createTopologyPlanningSnapshotReader(
  options: GroupTopologyManagementServiceOptions,
  queryService: GroupTopologyConfigQueryService,
): GroupTopologyPlanningServiceDependencies['readCurrentGroupSnapshot'] {
  const groupStateRepository = options.groupStateRepository;
  return async (groupRef, knownGroup) => {
    if (!knownGroup) {
      return await queryService.findCurrentGroupSnapshot(groupRef);
    }
    if (groupStateRepository) {
      return await groupStateRepository.readSnapshot(groupRef);
    }
    return (
      (await options.findGroupSnapshotByRef(groupRef, {
        minCausalRevision: knownGroup.causalRevision,
      })) ?? (await options.findGroupSnapshotByRef(groupRef))
    );
  };
}

function createTopologyPlanningRttReader(
  options: GroupTopologyManagementServiceOptions,
): GroupTopologyPlanningServiceDependencies['readRttMeasurements'] {
  const rttRepository = options.rttRepository;
  if (rttRepository) {
    return async (group) =>
      await rttRepository.listMeasurementsForSessionIds(
        group.activeSessions.map((session) => session.sessionId),
      );
  }
  return () => options.processRttReader?.() ?? processRttRepository.getAllRtt();
}

export function requireTopologyManagementService(
  service: GroupTopologyManagementService | undefined,
): GroupTopologyManagementService {
  if (!service) {
    throw new TypeError('Topology management service is not configured');
  }
  return service;
}
