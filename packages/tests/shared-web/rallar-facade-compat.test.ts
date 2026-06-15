import { describe, expect, it, vi } from 'vitest';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';

describe('Rallar composed facade compatibility', () => {
    it('exposes the expected compatibility facade shape', () => {
        const facade = createRallarFacade();

        for (
            const method of [
                'configure',
                'setDefaults',
                'defaults',
                'connect',
                'start',
                'disconnect',
                'status',
                'isConnected',
                'session',
                'subscriptions',
                'flow',
            ] as const
        ) {
            expect(typeof facade[method]).toBe('function');
        }

        expect(Object.keys(facade.auth).sort()).toEqual([
            'isLoggedIn',
            'login',
            'logout',
            'onChange',
            'register',
            'registerAndLogin',
            'restore',
        ]);
        expect(Object.keys(facade.rooms).sort()).toEqual([
            'create',
            'current',
            'enter',
            'join',
            'leave',
            'list',
            'listEventPage',
            'listEvents',
            'onChange',
            'onEvent',
            'refresh',
            'replayEvents',
            'session',
            'state',
            'updateMetadata',
        ]);
        expect(Object.keys(facade.people).sort()).toEqual([
            'get',
            'list',
            'listEventPage',
            'listEvents',
            'onChange',
            'onEvent',
            'refresh',
            'replayEvents',
            'state',
        ]);
        expect(Object.keys(facade.messages).sort()).toEqual([
            'channel',
            'room',
            'rtc',
            'ws',
        ]);
        expect(Object.keys(facade.realtime).sort()).toEqual([
            'health',
            'json',
            'onBinary',
            'onJson',
            'room',
            'sendBinary',
            'sendJson',
        ]);
        expect(Object.keys(facade.rtc).sort()).toEqual([
            'activePeerIds',
            'diagnostics',
            'knownPeerIds',
            'onLifecycle',
            'onStatus',
            'openRoom',
            'peer',
            'peerIdsWithNoReconnectableLanes',
            'readyPeerIds',
            'reconnectPeer',
            'restartIce',
            'roomStatus',
            'status',
            'waitForLane',
            'waitForOpen',
            'waitForRoom',
            'waitForRoomLane',
        ]);
        expect(Object.keys(facade.director).sort()).toEqual([
            'appoint',
            'createRelay',
            'onStatus',
            'resign',
            'status',
        ]);
        expect(Object.keys(facade.calls).sort()).toEqual([
            'invite',
            'onInvite',
            'onSignal',
            'start',
        ]);
        expect(Object.keys(facade.media).sort()).toEqual([
            'camera',
            'microphone',
            'onRemoteStream',
            'screen',
            'setAudioEnabled',
            'setLocalStream',
            'setPolicy',
            'setVideoEnabled',
            'stopLocal',
        ]);
    });

    it('groups subscriptions and cleans them up idempotently', () => {
        const facade = createRallarFacade();
        const first = vi.fn();
        const second = vi.fn();
        const late = vi.fn();

        const scope = facade.subscriptions();

        expect(scope.add(first)).toBe(scope);
        scope.add(undefined);
        scope.add(second);
        expect(scope.size()).toBe(2);

        scope.unsubscribe();
        scope.unsubscribe();

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(scope.size()).toBe(0);

        scope.add(late);

        expect(late).toHaveBeenCalledOnce();
        expect(scope.size()).toBe(0);
    });
});
