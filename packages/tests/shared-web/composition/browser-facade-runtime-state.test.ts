import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarDefaults, RallarFacade, RallarSetupInput } from '@shared-web/browser/rallar.ts';
import type { ApplicationId, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('Browser facade runtime state', () => {
    it('clones defaults and resolves operation options from them', () => {
        const shouldRetry = vi.fn(() => true);
        const signal = new AbortController().signal;
        const lanes: readonly RtcDataChannelLaneConfig[] = [
            { id: 'motion', label: 'rtc-motion' }
        ];
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));

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

        Object.assign(defaults?.room ?? {}, { roomId: 'mutated' });

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

    it('copies capture defaults and keeps an explicit operation mode through projection', () => {
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
        const defaults = { applicationId: 'app', rtc: { captureMode: 'native' as const } };
        context.setDefaults(defaults);
        Object.assign(defaults.rtc, { captureMode: 'off' });
        expect(context.defaults()?.rtc?.captureMode).toBe('native');
        const copy = context.defaults();
        Object.assign(copy?.rtc ?? {}, { captureMode: 'signaling' });
        expect(context.defaults()?.rtc?.captureMode).toBe('native');
        expect(context.resolveOperationOptions({ rtcCaptureMode: 'off' })).toEqual({ rtcCaptureMode: 'off' });
    });

    it('stores capture-only defaults without inventing application identity and isolates both clones', () => {
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
        const defaults = { rtc: { captureMode: 'native' as const } };
        context.setDefaults(defaults);

        Object.assign(defaults.rtc, { captureMode: 'off' });
        expect.soft(context.readDefaults()).toStrictEqual({ rtc: { captureMode: 'native' } });
        const copy = context.defaults();
        expect.soft(copy).toStrictEqual({ rtc: { captureMode: 'native' } });
        Object.assign(copy?.rtc ?? {}, { captureMode: 'signaling' });
        expect.soft(context.defaults()).toStrictEqual({ rtc: { captureMode: 'native' } });
    });

    it('clears the previous default scope for capture-only settings and keeps an explicit operation scope', () => {
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
        context.setDefaults({ applicationId: 'app', workspaceId: 'workspace' });
        expect(context.readDefaultScope()).toEqual({ applicationId: 'app', workspaceId: 'workspace' });

        context.setDefaults({ rtc: { captureMode: 'off' } });
        expect.soft(context.readDefaultScope()).toBeUndefined();
        expect.soft(context.resolveOperationScope()).toBeUndefined();
        const explicitScope = { applicationId: 'operation-app', workspaceId: 'operation-workspace' };
        expect(context.resolveOperationScope(explicitScope)).toBe(explicitScope);
    });

    it('accepts capture-only public defaults while Setup still requires an application', () => {
        const defaults = { rtc: { captureMode: 'native' as const } };
        expectTypeOf(defaults).toMatchTypeOf<RallarDefaults>();
        expectTypeOf<RallarFacade['setDefaults']>().toBeCallableWith(defaults);
        expectTypeOf<Pick<RallarSetupInput, 'applicationId'>>().toEqualTypeOf<{ readonly applicationId: ApplicationId; }>();
    });

    it('keeps current room and connection state isolated per context', () => {
        const first = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
        const second = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));

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
        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));

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
