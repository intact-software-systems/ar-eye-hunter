import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

type RoomDefaults = NonNullable<RallarDefaults['room']>;

type MutableRoomDefaults = {
    -readonly [K in keyof RoomDefaults]: RoomDefaults[K];
};

describe('Browser facade runtime state', () => {
    it('clones defaults and resolves operation options from them', () => {
        const shouldRetry = vi.fn(() => true);
        const signal = new AbortController().signal;
        const lanes: readonly RtcDataChannelLaneConfig[] = [
            { id: 'motion', label: 'rtc-motion' }
        ];
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());

        context.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            room: {
                roomId: 'room-1'
            },
            rtc: {
                dataChannelLanes: lanes,
                maxPeerConnections: 12,
                rttReportingDegreeLimit: 3
            },
            messages: {
                maxPayloadBytes: 2048
            },
            operations: {
                timeoutMs: 500,
                maxAttempts: 3,
                shouldRetry
            }
        });

        const defaults = context.defaults();
        expect(defaults).toEqual({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            room: {
                roomId: 'room-1'
            },
            rtc: {
                dataChannelLanes: lanes,
                maxPeerConnections: 12,
                rttReportingDegreeLimit: 3
            },
            messages: {
                maxPayloadBytes: 2048
            },
            operations: {
                timeoutMs: 500,
                maxAttempts: 3,
                shouldRetry
            }
        });
        expect(defaults?.room).not.toBe(context.readDefaults()?.room);

        const mutableRoom = defaults?.room as MutableRoomDefaults;
        mutableRoom.roomId = 'mutated';

        expect(context.defaults()?.room?.roomId).toBe('room-1');
        expect(context.resolveOperationScope()).toEqual({
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });
        expect(
            context.resolveOperationOptions({
                signal,
                timeoutMs: 100
            })
        ).toEqual({
            signal,
            timeoutMs: 100,
            maxAttempts: 3,
            shouldRetry,
            dataChannelLanes: lanes,
            maxPeerConnections: 12,
            rttReportingDegreeLimit: 3
        });
    });

    it('keeps current room and connection state isolated per context', () => {
        const first = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
        const second = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());

        first.setCurrentRoom(createGroupSnapshot('room-1'));
        first.setConnectState('connected');

        expect(first.currentRoomId()).toBe('room-1');
        expect(first.currentRoomRef()).toMatchObject({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        });
        expect(first.readConnectState()).toBe('connected');

        expect(second.currentRoomId()).toBeUndefined();
        expect(second.currentRoomRef()).toBeUndefined();
        expect(second.readConnectState()).toBe('idle');
    });

    it('reports missing middleware through its transport runtime', () => {
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());

        expect(context.readMiddleware()).toBeUndefined();
        expect(() => context.requireMiddleware()).toThrow(
            'Rallar is not connected. Call rallar.connect() first.'
        );
    });
});

function createGroupSnapshot(groupId: string): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        sessionIds: []
    });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            displayName: 'Room',
            metadataVersion: 1
        }
    };
}
