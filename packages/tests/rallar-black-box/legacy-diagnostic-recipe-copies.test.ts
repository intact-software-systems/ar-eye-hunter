// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useRoomsClientsController,
    type RoomsClientsControllerModel
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/use-rooms-clients-controller.ts';
import {
    useRtcRealtimeController,
    type RtcRealtimeControllerModel
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts';

vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { recordRuntimeEvent: () => {} },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test-token', expiresAtEpochMs: 100_000 };
const input = {
    state,
    bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar', {}, ''),
    authSession,
    globalValues: {
        apiBaseUrl: 'http://localhost',
        applicationId: 'app',
        workspaceId: 'workspace',
        clientId: 'client',
        sessionId: 'session',
        roomId: 'room-a'
    }
};

function RtcRealtimeHarness(props: { globalValues?: typeof input.globalValues; capture(view: RtcRealtimeControllerModel): void; }) {
    const view = useRtcRealtimeController({ ...input, globalValues: props.globalValues ?? input.globalValues });
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}
function RoomsClientsHarness(props: { capture(view: RoomsClientsControllerModel): void; }) {
    const view = useRoomsClientsController(input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

describe('legacy diagnostic recipe copies', () => {
    let root: Root;
    let container: HTMLDivElement;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it.each(['realtime', 'messages.rtc'] as const)(
        'copies the direct RTC realtime export for %s as a strict version-1 recipe carrying the configured send',
        async (transport) => {
            const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
            let rtcRealtime: RtcRealtimeControllerModel | undefined;
            await act(async () =>
                root.render(createElement(RtcRealtimeHarness, {
                    capture: (view) => {
                        rtcRealtime = view;
                    }
                }))
            );
            await act(async () => {
                rtcRealtime?.setTransport(transport);
                rtcRealtime?.setLaneId('lane-a');
                rtcRealtime?.setPeerIdsText('peer-a, peer-b');
                rtcRealtime?.setTypeId('room.custom.message');
                rtcRealtime?.setTopicId('room.custom');
                rtcRealtime?.setContextId('context-a');
                rtcRealtime?.setPayloadText('{"text":"hello"}');
                rtcRealtime?.setMinSnapshotVersion('7');
                rtcRealtime?.setReliability('at-least-once');
                rtcRealtime?.setAck('receiver');
                rtcRealtime?.setOwnership('exclusive');
                rtcRealtime?.setTimeoutMs(2_500);
            });
            rtcRealtime?.copyRecipe();
            const recipe = JSON.parse(clipboard.mock.calls.at(-1)?.[0] ?? 'null');
            const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-a' };
            const send = transport === 'realtime'
                ? { data: { text: 'hello' }, laneId: 'lane-a', roomId: 'room-a', roomRef, peerIds: ['peer-a', 'peer-b'], openTimeoutMs: 2_500 }
                : {
                    roomId: 'room-a',
                    roomRef,
                    typeId: 'room.custom.message',
                    topicId: 'room.custom',
                    contextId: 'context-a',
                    payload: { text: 'hello' },
                    minSnapshotVersion: 7,
                    reliability: 'at-least-once',
                    ack: 'receiver',
                    ownership: 'exclusive',
                    nextHopPeerIds: ['peer-a', 'peer-b'],
                    overlayId: 'room-a'
                };

            expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe })).toEqual({ ok: true });
            expect(recipe).toEqual({
                schemaVersion: 1,
                recipeId: 'rallar-direct-rtc-realtime-export',
                name: 'Direct RTC/Realtimes export from Rallar Black Box',
                metadata: {
                    requirements: ['provider=browser-rallar', 'logged-in browser session', 'joined group with RTC signaling available']
                },
                commands: [
                    {
                        kind: 'rtc.connect',
                        commandId: 'rtc-realtime-connect',
                        roomId: 'room-a',
                        transport,
                        timeoutMs: 2_500,
                        rallar: { applicationId: 'app', workspaceId: 'workspace', roomRef }
                    },
                    { kind: 'rtc.send', commandId: 'rtc-realtime-send', transport, timeoutMs: 2_500, send }
                ]
            });
        }
    );

    it('omits the room from the RTC realtime export when no group is active so the recipe still validates', async () => {
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        let rtcRealtime: RtcRealtimeControllerModel | undefined;
        await act(async () =>
            root.render(createElement(RtcRealtimeHarness, {
                globalValues: { ...input.globalValues, roomId: '' },
                capture: (view) => {
                    rtcRealtime = view;
                }
            }))
        );
        rtcRealtime?.copyRecipe();
        const recipe = JSON.parse(clipboard.mock.calls.at(-1)?.[0] ?? 'null');

        expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe })).toEqual({ ok: true });
        expect(recipe.commands[0]).toEqual({
            kind: 'rtc.connect',
            commandId: 'rtc-realtime-connect',
            transport: 'realtime',
            timeoutMs: expect.any(Number),
            rallar: { applicationId: 'app', workspaceId: 'workspace' }
        });
    });

    it('copies the rooms and clients state recipe as a strict version-1 recipe', async () => {
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        let roomsClients: RoomsClientsControllerModel | undefined;
        await act(async () =>
            root.render(createElement(RoomsClientsHarness, {
                capture: (view) => {
                    roomsClients = view;
                }
            }))
        );
        roomsClients?.copyStateRecipe();
        const recipe = JSON.parse(clipboard.mock.calls.at(-1)?.[0] ?? 'null');

        expect(recipe).toMatchObject({ schemaVersion: 1 });
        expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe })).toEqual({ ok: true });
    });
});
