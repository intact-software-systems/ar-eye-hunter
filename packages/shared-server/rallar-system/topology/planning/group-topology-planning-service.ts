import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
    EffectiveGroupTopologyConfig,
    ReconfigureGroupTopologyResponse
} from '@shared/api/graph-topology-management-types.ts';
import { readGroupCreatedByPrincipalId, readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { filterRtcRttMeasurementsForGroup } from '../../rtc-rtt/policy/rtc-rtt-measurement-policy.ts';
import type { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import type { GroupTopologyServerOptions } from '../config/group-topology-config.ts';
import { GroupTopologyValidationError } from '../group-topology-errors.ts';
import type {
    GroupTopologyGroupSnapshotReader,
    GroupTopologyPublisher,
    ReconcileGroupTopologyResult,
    ReconfigureGroupTopologyInput
} from '../group-topology-management-contracts.ts';
import { compareRtcTopologyIdentifiers } from '../persistence/rtc-topology-identifiers.ts';
import { DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS } from '../publication/rtc-topology-publication-repository-contracts.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyUpdateResult,
    type RtcTopologyPlanningIntent
} from '../runtime/rallar-rtc-topology-service.ts';
import type {
    GroupTopologyPlanningAuthority,
    ReadGroupTopologyPlanningAuthorityInput
} from './group-topology-planning-authority.ts';
import { materializeRtcOverlayTopologyBroadcastMessage } from './materialize-rtc-overlay-topology-broadcast-message.ts';
import {
    isGroupTopologyPlannableAt,
    selectGroupTopologyPlanningSnapshot
} from './select-group-topology-planning-snapshot.ts';

export interface GroupTopologyPlanningServiceDependencies {
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly queryService: Pick<GroupTopologyConfigQueryService, 'readConfig' | 'readResolvedTopologyConfig'>;
    readonly topologyService: RallarRtcTopologyService;
    readonly readCurrentGroupSnapshot: (
        groupRef: GroupRef,
        knownGroup: GroupSnapshot | undefined
    ) => Promise<GroupSnapshot | undefined>;
    readonly readRttMeasurements: (
        group: GroupSnapshot
    ) => readonly RttMeasurementInfo[] | Promise<readonly RttMeasurementInfo[]>;
    readonly topologyMode: 'local' | 'persistent';
    readonly publisher?: GroupTopologyPublisher;
    readonly serverDefaults?: GroupTopologyServerOptions;
}

export class GroupTopologyPlanningService {
    private readonly dependencies: GroupTopologyPlanningServiceDependencies;

    constructor(dependencies: GroupTopologyPlanningServiceDependencies) {
        this.dependencies = dependencies;
    }

    recordTopologyPublication(published: boolean): void {
        this.dependencies.topologyService.recordTopologyPublishResult(published);
    }

    recordTopologyRebuildSkippedFingerprint(): void {
        this.dependencies.topologyService.recordTopologyRebuildSkippedFingerprint();
    }

    async readTopologyPlanningAuthority(
        input: ReadGroupTopologyPlanningAuthorityInput
    ): Promise<GroupTopologyPlanningAuthority> {
        const currentGroup = await this.dependencies.readCurrentGroupSnapshot(
            input.groupRef,
            input.knownGroup
        );
        const group = input.knownGroup
            ? selectGroupTopologyPlanningSnapshot(input.knownGroup, currentGroup, input.snapshotSelection)
            : requireGroupTopologyPlanningSnapshot(input.groupRef, currentGroup);
        const [config, rttMeasurements] = await Promise.all([
            this.dependencies.queryService.readResolvedTopologyConfig(group.group, input.requestOptions),
            this.readRawRttMeasurements(group)
        ]);
        return {
            group,
            config,
            kindHysteresisWidths: this.dependencies.topologyService.readKindHysteresisWidths(),
            rttMeasurements,
            nowEpochMs: this.dependencies.topologyService.readNowEpochMs()
        };
    }

    computeTopologyFromAuthority(
        authority: GroupTopologyPlanningAuthority,
        previous: RallarOverlayTopologySnapshot | undefined,
        planningIntent: RtcTopologyPlanningIntent = 'full-rebuild'
    ): ReconcileGroupTopologyResult {
        if (!isGroupTopologyPlannableAt(authority.group, authority.nowEpochMs)) {
            return removedTopologyResult(authority.group, previous);
        }
        const filteredRttMeasurements = this.filterRttMeasurementsForGroup(
            authority.group,
            authority.rttMeasurements,
            authority.config.effective,
            previous
        );
        const result = this.dependencies.topologyService.planGroupTopologyAt(
            authority.group,
            filteredRttMeasurements,
            { previous, topologyOptions: authority.config.effective, planningIntent },
            authority.nowEpochMs
        );
        this.validateTopology(result.snapshot);
        return result;
    }

    async computeGroupTopology(
        group: GroupSnapshot,
        previous: RallarOverlayTopologySnapshot | undefined
    ): Promise<ReconcileGroupTopologyResult> {
        const authority = await this.readTopologyPlanningAuthority({
            groupRef: group.group,
            knownGroup: group,
            snapshotSelection: 'prefer-current'
        });
        return this.computeTopologyFromAuthority(authority, previous);
    }

    async reconfigureGroupTopology(
        input: ReconfigureGroupTopologyInput
    ): Promise<ReconfigureGroupTopologyResponse> {
        this.requireLocalTopology('Topology reconfiguration requires AppInbox execution');
        const group = await this.readReconfigureGroup(input);
        const config = await this.dependencies.queryService.readResolvedTopologyConfig(
            input.groupRef,
            input.requestOptions
        );
        const previous = this.dependencies.topologyService.readSnapshot(group);
        const result = this.dependencies.topologyService.updateGroupTopology(
            group,
            this.filterRttMeasurementsForGroup(
                group,
                await this.readRawRttMeasurements(group),
                config.effective,
                previous
            ),
            { previous, topologyOptions: config.effective }
        );
        this.validateTopology(result.snapshot);
        const published = await this.publishIfRequested(
            group,
            result,
            input.publisher,
            input.publish ?? true
        );
        return toReconfigureGroupTopologyResponse({
            groupRef: input.groupRef,
            result,
            config,
            published
        });
    }

    async reconcileGroupTopology(group: GroupSnapshot): Promise<ReconcileGroupTopologyResult> {
        if (this.dependencies.topologyMode === 'persistent') {
            throw new TypeError('Persistent topology reconciliation requires APP_OUTBOX');
        }
        const previous = this.dependencies.topologyService.readSnapshot(group);
        const result = await this.computeGroupTopology(group, previous);
        this.observeCommittedTopology(group, result.snapshot);
        return result;
    }

    observeCommittedTopology(group: GroupSnapshot, snapshot: RallarOverlayTopologySnapshot): void {
        if (snapshot.state === 'removed') {
            this.dependencies.topologyService.removeGroupTopology(group);
            return;
        }
        this.dependencies.topologyService.observeCommittedTopologySnapshot(snapshot);
    }

    async flushDueGroupTopology(
        input: ReconfigureGroupTopologyInput
    ): Promise<ReconfigureGroupTopologyResponse | undefined> {
        if (this.dependencies.topologyMode === 'persistent') {
            return undefined;
        }
        const group = await this.readReconfigureGroup(input);
        const config = await this.dependencies.queryService.readConfig(input.groupRef);
        const previous = this.dependencies.topologyService.readSnapshot(group);
        const result = this.dependencies.topologyService.flushDueRttTopologyUpdate(
            group,
            this.filterRttMeasurementsForGroup(
                group,
                await this.readRawRttMeasurements(group),
                config.effective,
                previous
            ),
            { previous, topologyOptions: config.effective }
        );
        if (!result) {
            return undefined;
        }
        this.validateTopology(result.snapshot);
        const published = await this.publishIfRequested(
            group,
            result,
            input.publisher,
            input.publish ?? true
        );
        return toReconfigureGroupTopologyResponse({
            groupRef: input.groupRef,
            result,
            config,
            published
        });
    }

    removeGroupTopology(group: GroupSnapshot): Promise<void> {
        if (this.dependencies.topologyMode === 'local') {
            this.dependencies.topologyService.removeGroupTopology(group);
        }
        return Promise.resolve();
    }

    private async readReconfigureGroup(input: ReconfigureGroupTopologyInput): Promise<GroupSnapshot> {
        const group = input.groupSnapshot ?? (await this.dependencies.findGroupSnapshotByRef(input.groupRef));
        if (!group) {
            throw new Error(`Group snapshot not found: ${input.groupRef.groupId}`);
        }
        return group;
    }

    private async readRawRttMeasurements(
        group: GroupSnapshot
    ): Promise<readonly RttMeasurementInfo[]> {
        return await this.dependencies.readRttMeasurements(group);
    }

    private filterRttMeasurementsForGroup(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        topologyOptions: EffectiveGroupTopologyConfig,
        overlaySnapshot: RallarOverlayTopologySnapshot | undefined
    ): readonly RttMeasurementInfo[] {
        if (rttMeasurements.length === 0) {
            return rttMeasurements;
        }
        return filterRtcRttMeasurementsForGroup({
            group,
            rttMeasurements,
            overlaySnapshot,
            degreeLimit: this.dependencies.topologyService.readRttReportingDegreeLimit({
                ...topologyOptions,
                rttReportingDegreeLimit: this.dependencies.serverDefaults?.rttReportingDegreeLimit
            })
        });
    }

    private validateTopology(snapshot: RallarOverlayTopologySnapshot): void {
        if (snapshot.state === 'removed') {
            return;
        }
        const result = validateGroupTopologyNextHops({
            activeSessionIds: new Set(snapshot.activeSessionIds),
            nextHopsBySessionId: snapshot.nextHopsBySessionId,
            maxDegree: snapshot.degreeLimit
        });
        if (!result.valid) {
            throw new GroupTopologyValidationError(
                result.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.sessionId ? ['nextHopsBySessionId', issue.sessionId] : undefined,
                    message: issue.code,
                    details: issue
                }))
            );
        }
    }

    private async publishIfRequested(
        group: GroupSnapshot,
        result: RallarRtcTopologyUpdateResult,
        publisher: GroupTopologyPublisher | undefined,
        publish: boolean
    ): Promise<boolean> {
        if (!publish) {
            return false;
        }
        const resolvedPublisher = publisher ?? this.dependencies.publisher;
        if (!resolvedPublisher) {
            this.recordTopologyPublication(false);
            return false;
        }
        const createdAtEpochMs = this.dependencies.topologyService.readNowEpochMs();
        const deliveredCount = await resolvedPublisher(
            materializeRtcOverlayTopologyBroadcastMessage(group, result.snapshot, {
                workId: crypto.randomUUID(),
                createdAtEpochMs,
                expiresAtEpochMs: createdAtEpochMs + DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS
            }),
            result.snapshot
        );
        const published = deliveredCount > 0;
        this.recordTopologyPublication(published);
        return published;
    }

    private requireLocalTopology(message: string): void {
        if (this.dependencies.topologyMode === 'persistent') {
            throw new TypeError(message);
        }
    }
}

function requireGroupTopologyPlanningSnapshot(
    groupRef: GroupRef,
    snapshot: GroupSnapshot | undefined
): GroupSnapshot {
    if (!snapshot) {
        throw new Error(`Group snapshot not found: ${groupRef.groupId}`);
    }
    return snapshot;
}

function removedTopologyResult(
    group: GroupSnapshot,
    previous: RallarOverlayTopologySnapshot | undefined
): ReconcileGroupTopologyResult {
    const activeSessionIds = [
        ...new Set([...(previous?.activeSessionIds ?? []), ...readGroupMemberSessionIds(group)])
    ].sort(compareRtcTopologyIdentifiers);
    return {
        snapshot: {
            sourceGroupStateCausalRevision: group.causalRevision,
            state: 'removed',
            overlayId: toScopedOverlayId(group.group),
            groupRef: canonicalGroupRef(group.group),
            name: previous?.name ?? group.group.displayName,
            topology: previous?.topology ?? 'star',
            activeSessionIds,
            nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((sessionId) => [sessionId, []])),
            degreeLimit: previous?.degreeLimit ?? 1,
            version: previous?.version ?? 0,
            createdByClientId: previous?.createdByClientId ?? readGroupCreatedByPrincipalId(group),
            createdAtEpochMs: previous?.createdAtEpochMs ?? group.group.created.atEpochMs,
            updatedAtEpochMs: group.group.updated.atEpochMs
        },
        previous: previous ?? null,
        changed: previous?.state !== 'removed'
    };
}

interface ReconfigureGroupTopologyResponseInput {
    readonly groupRef: GroupRef;
    readonly result: RallarRtcTopologyUpdateResult;
    readonly config: Awaited<ReturnType<GroupTopologyConfigQueryService['readConfig']>>;
    readonly published: boolean;
}

function toReconfigureGroupTopologyResponse(
    input: ReconfigureGroupTopologyResponseInput
): ReconfigureGroupTopologyResponse {
    return {
        groupRef: input.groupRef,
        overlayId: input.result.snapshot.overlayId,
        changed: input.result.changed,
        snapshot: input.result.snapshot,
        previous: input.result.previous,
        config: input.config,
        published: input.published
    };
}

function canonicalGroupRef(groupRef: GroupRef): GroupRef {
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}
