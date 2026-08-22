import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { createRallarBrowserFacadeRuntimeContext, type RallarBrowserRuntimeDefaults } from '@shared-web/browser/rallar-runtime-context.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import { describe, expect, it, vi } from 'vitest';
import { createApiMiddlewareTestDouble } from './api-middleware-test-double.ts';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type RoomDefaults = NonNullable<RallarBrowserRuntimeDefaults['room']>;

type MutableRoomDefaults = {
    -readonly [K in keyof RoomDefaults]: RoomDefaults[K];
};

describe('Rallar browser facade runtime context', () => {
    it('clones defaults and resolves operation options from them', () => {
        const shouldRetry = vi.fn(() => true);
        const signal = new AbortController().signal;
        const lanes: readonly RtcDataChannelLaneConfig[] = [
            { id: 'motion', label: 'rtc-motion' }
        ];
        const context = createRallarBrowserFacadeRuntimeContext();

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
        const first = createRallarBrowserFacadeRuntimeContext();
        const second = createRallarBrowserFacadeRuntimeContext();

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

    it('reads middleware lazily and reports missing middleware through require', () => {
        const middleware = createMiddleware('session-1');
        let ready = false;
        const context = createRallarBrowserFacadeRuntimeContext({
            isMiddlewareReady: () => ready,
            getMiddleware: () => middleware
        });

        expect(context.readMiddleware()).toBeUndefined();
        expect(() => context.requireMiddleware()).toThrow(
            'Rallar is not connected. Call rallar.connect() first.'
        );

        ready = true;

        expect(context.readMiddleware()).toBe(middleware);
        expect(context.requireMiddleware()).toBe(middleware);
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

function createMiddleware(sessionId: string): ApiMiddleware {
    return createApiMiddlewareTestDouble({
        session: {
            clientId: 'client-1',
            sessionId,
            username: 'user-1',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000
        }
    });
}
