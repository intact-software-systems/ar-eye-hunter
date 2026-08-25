import { describe, expect, it } from 'vitest';

import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions,
    type RallarRtcTopologyUpdateOptions,
    type RallarRtcTopologyUpdateResult
} from '@shared-server/mod.ts';
import { computeCanonicalTopologyPairWeight } from '@shared-server/rallar-system/topology/planning/canonical-topology-planning-input.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { createRtcTopologyGroupSnapshot, createRtcTopologyMemberIds, createRtcTopologyRttMeasurement } from '../rtc-topology-test-fixtures.ts';

describe('RallarRtcTopologyService public facade', () => {
    it('creates scoped star topology for groups below tree size', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(4));
        const service = new RallarRtcTopologyService({ now: () => 100 });

        const result = service.updateGroupTopology(group);

        expect(result.changed).toBe(true);
        expect(result.snapshot.overlayId).toBe(toScopedOverlayId(group.group));
        expect(result.snapshot.topology).toBe('star');
        expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual(['peer-2', 'peer-3', 'peer-4']);
    });

    it('plans a topology without observing it in the process cache', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(4));
        const service = new RallarRtcTopologyService({ now: () => 100 });

        const result = service.planGroupTopology(group);

        expect(result.changed).toBe(true);
        expect(service.readSnapshot(group)).toBeUndefined();
    });

    it('updates through the public planning and observation methods', () => {
        const service = new RecordingRtcTopologyService();

        const result = service.updateGroupTopology(createGroup());

        expect(service.calls).toEqual([
            'updateGroupTopology',
            'planGroupTopology',
            'planGroupTopologyAt',
            'selectTopology',
            'observeTopologySnapshot'
        ]);
        expect(result.snapshot.topology).toBe('star');
    });

    it('honors the public topology-selection override while planning', () => {
        const service = new RecordingRtcTopologyService({ selectedTopology: 'tree' });

        const result = service.planGroupTopologyAt(createGroup(), [], {}, 100);

        expect(service.calls).toEqual(['planGroupTopologyAt', 'selectTopology']);
        expect(result.snapshot.topology).toBe('tree');
    });

    it('honors public topology and RTT-degree policy overrides while creating a room graph', () => {
        const service = new RecordingRtcTopologyService({
            selectedTopology: 'tree',
            rttReportingDegreeLimit: 0
        });

        const graph = service.createRoomGraph(createGroup(), [
            createRtcTopologyRttMeasurement({
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-2',
                rttMs: 1,
                version: 1
            })
        ]);

        expect(service.calls).toEqual(['selectTopology', 'readRttReportingDegreeLimit']);
        expect(graph.getEdgeAttribute(graph.edge('peer-1', 'peer-2')!, 'weight')).toBe(
            computeCanonicalTopologyPairWeight('peer-1', 'peer-2')
        );
    });

    it('returns the public observation override result for a committed snapshot', () => {
        const service = new RecordingRtcTopologyService({ observeResult: false });

        const result = service.observeCommittedTopologySnapshot(createSnapshot(createGroup()));

        expect(service.calls).toEqual(['observeTopologySnapshot']);
        expect(result).toBe(false);
    });

    it('claims a due update before using the public update methods', () => {
        const service = new RecordingRtcTopologyService();
        const group = createGroup();
        service.queueRttTopologyUpdate(group);
        service.calls.length = 0;

        const result = service.flushDueRttTopologyUpdate(group);

        expect(service.calls).toEqual([
            'claimDueRttTopologyUpdate',
            'updateGroupTopology',
            'planGroupTopology',
            'planGroupTopologyAt',
            'selectTopology',
            'observeTopologySnapshot'
        ]);
        expect(result?.snapshot.topology).toBe('star');
    });
});

interface RecordingRtcTopologyServiceOptions {
    readonly selectedTopology?: RallarRtcTopologyKind;
    readonly rttReportingDegreeLimit?: number;
    readonly observeResult?: boolean;
}

class RecordingRtcTopologyService extends RallarRtcTopologyService {
    readonly calls: string[] = [];
    private readonly recordingOptions: RecordingRtcTopologyServiceOptions;

    constructor(recordingOptions: RecordingRtcTopologyServiceOptions = {}) {
        super({ now: () => 100 });
        this.recordingOptions = recordingOptions;
    }

    override updateGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {}
    ): RallarRtcTopologyUpdateResult {
        this.calls.push('updateGroupTopology');
        return super.updateGroupTopology(group, rttMeasurements, options);
    }

    override planGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {}
    ): RallarRtcTopologyUpdateResult {
        this.calls.push('planGroupTopology');
        return super.planGroupTopology(group, rttMeasurements, options);
    }

    override planGroupTopologyAt(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[],
        options: RallarRtcTopologyUpdateOptions,
        nowEpochMs: number
    ): RallarRtcTopologyUpdateResult {
        this.calls.push('planGroupTopologyAt');
        return super.planGroupTopologyAt(group, rttMeasurements, options, nowEpochMs);
    }

    override selectTopology(
        group: GroupSnapshot,
        options?: RallarRtcTopologyServiceOptions,
        previousKind?: RallarRtcTopologyKind
    ): RallarRtcTopologyKind {
        this.calls.push('selectTopology');
        return (
            this.recordingOptions.selectedTopology ?? super.selectTopology(group, options, previousKind)
        );
    }

    override readRttReportingDegreeLimit(options?: RallarRtcTopologyServiceOptions): number {
        this.calls.push('readRttReportingDegreeLimit');
        return (
            this.recordingOptions.rttReportingDegreeLimit ?? super.readRttReportingDegreeLimit(options)
        );
    }

    override observeTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): boolean {
        this.calls.push('observeTopologySnapshot');
        return this.recordingOptions.observeResult ?? super.observeTopologySnapshot(snapshot);
    }

    override claimDueRttTopologyUpdate(groupRef: GroupRef): boolean {
        this.calls.push('claimDueRttTopologyUpdate');
        return super.claimDueRttTopologyUpdate(groupRef);
    }
}

function createGroup(): GroupSnapshot {
    return createRtcTopologyGroupSnapshot('subclass-dispatch', createRtcTopologyMemberIds(3));
}

function createSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot {
    return new RallarRtcTopologyService({ now: () => 100 }).planGroupTopology(group).snapshot;
}
