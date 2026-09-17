// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../apps/rallar-black-box/src/client-defaults.ts';
import type { RtcRealtimeViewModel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/rtc-realtime-contracts.ts';
import { RtcRealtimePanel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx';
import {
    useRtcRealtimeController,
    type UseRtcRealtimeControllerInput
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts';
import { CLIPBOARD_FAILURES } from './write-text-to-clipboard-fixtures.ts';

interface RecordedRuntimeEvent {
    readonly event: RallarBlackBoxTestRuntimeEventInput;
    readonly lastAction: string | undefined;
}
interface RealtimeMessageFixture {
    readonly peerId: string;
    readonly laneId: string;
    readonly data: RallarBlackBoxTestRecord;
    readonly receivedAtEpochMs: number;
}
interface RealtimeListener {
    readonly laneId: string;
    handler(message: RealtimeMessageFixture): void;
}
interface RtcMessageListener {
    readonly selector: RallarBlackBoxTestRecord;
    handler(message: RallarBlackBoxTestRecord): void;
}

const loadFacade = vi.hoisted(() => vi.fn());
const runtimeEvents = vi.hoisted(() => [] as RecordedRuntimeEvent[]);
vi.mock('../../../apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts', () => ({ loadBrowserRallarFacade: loadFacade }));
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: {
        recordRuntimeEvent: (event: RallarBlackBoxTestRuntimeEventInput, lastAction: string | undefined) => runtimeEvents.push({ event, lastAction })
    }
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test-token', expiresAtEpochMs: 100_000 };
const input: UseRtcRealtimeControllerInput = {
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
const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-a' };

function RtcRealtimeHarness(props: { input: UseRtcRealtimeControllerInput; capture(view: RtcRealtimeViewModel): void; }) {
    const view = useRtcRealtimeController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

describe('RTC realtime controller preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    let view: RtcRealtimeViewModel;
    let currentRoom: RallarBlackBoxTestRecord | undefined;
    let realtimeSendFailure: Error | undefined;
    const realtimeListeners = new Set<RealtimeListener>();
    const rtcMessageListeners = new Set<RtcMessageListener>();
    const facadeCalls = {
        configured: [] as RallarBlackBoxTestRecord[],
        defaults: [] as RallarBlackBoxTestRecord[],
        starts: [] as RallarBlackBoxTestRecord[],
        joins: [] as RallarBlackBoxTestRecord[],
        realtimeSends: [] as RallarBlackBoxTestRecord[],
        rtcSends: [] as RallarBlackBoxTestRecord[],
        laneWaits: [] as RallarBlackBoxTestRecord[],
        healthReads: [] as RallarBlackBoxTestRecord[]
    };
    const facade = {
        configure: (options: RallarBlackBoxTestRecord) => facadeCalls.configured.push(options),
        setDefaults: (defaults: RallarBlackBoxTestRecord) => facadeCalls.defaults.push(defaults),
        start: async (options: RallarBlackBoxTestRecord) => {
            facadeCalls.starts.push(options);
            return { session: authSession, connected: true };
        },
        rooms: {
            current: () => currentRoom,
            join: async (groupId: string, options: RallarBlackBoxTestRecord) => {
                facadeCalls.joins.push({ groupId, options });
                return { groupId };
            }
        },
        realtime: {
            onJson: (laneId: string, handler: (message: RealtimeMessageFixture) => void) => {
                const listener = { laneId, handler };
                realtimeListeners.add(listener);
                return () => realtimeListeners.delete(listener);
            },
            sendJson: async (send: RallarBlackBoxTestRecord) => {
                facadeCalls.realtimeSends.push(send);
                if (realtimeSendFailure) {
                    throw realtimeSendFailure;
                }
                return [{ peerId: 'peer-a', laneId: 'lane-a', result: { status: 'sent' } }];
            },
            health: (options: RallarBlackBoxTestRecord) => {
                facadeCalls.healthReads.push(options);
                return [{ peerId: 'peer-a', laneId: 'lane-a', state: 'open' }];
            }
        },
        messages: {
            rtc: {
                onMessage: (selector: RallarBlackBoxTestRecord, handler: (message: RallarBlackBoxTestRecord) => void) => {
                    const listener = { selector, handler };
                    rtcMessageListeners.add(listener);
                    return () => rtcMessageListeners.delete(listener);
                },
                send: async (send: RallarBlackBoxTestRecord) => {
                    facadeCalls.rtcSends.push(send);
                    return { msgId: 'msg-1' };
                }
            }
        },
        rtc: {
            waitForRoomLane: async (ref: RallarBlackBoxTestRecord, laneId: string, options: RallarBlackBoxTestRecord) => {
                facadeCalls.laneWaits.push({ ref, laneId, options });
                return { ready: true };
            }
        }
    };

    async function render(next: UseRtcRealtimeControllerInput = input): Promise<void> {
        await act(async () =>
            root.render(createElement(RtcRealtimeHarness, {
                input: next,
                capture: (captured) => {
                    view = captured;
                }
            }))
        );
    }

    async function configureForm(): Promise<void> {
        await act(async () => {
            view.setLaneId('lane-a');
            view.setPeerIdsText('peer-a, peer-b');
            view.setTypeId('room.custom.message');
            view.setTopicId('room.custom');
            view.setContextId('');
            view.setPayloadText('{"text":"hello"}');
            view.setMinSnapshotVersion('7');
            view.setReliability('at-least-once');
            view.setAck('receiver');
            view.setOwnership('exclusive');
            view.setTimeoutMs(2_500);
        });
    }

    function recordedPhases(): readonly string[] {
        return runtimeEvents.map(({ event, lastAction }) => {
            const payload = event.payload as RallarBlackBoxTestRecord;
            return event.topic === 'rallar.direct.rtc_realtime.phase'
                ? `${String(payload.phase)}:${String(payload.status)}`
                : `${event.topic} | ${lastAction}`;
        });
    }

    beforeEach(() => {
        loadFacade.mockResolvedValue(facade);
        runtimeEvents.length = 0;
        realtimeListeners.clear();
        rtcMessageListeners.clear();
        Object.values(facadeCalls).forEach((calls) => calls.splice(0));
        currentRoom = undefined;
        realtimeSendFailure = undefined;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it('exposes the default form and follows the global room into a default context id only', async () => {
        await render({ ...input, globalValues: { ...input.globalValues, roomId: '' } });
        const defaults = {
            transport: view.transport,
            laneId: view.laneId,
            typeId: view.typeId,
            topicId: view.topicId,
            contextId: view.contextId,
            payloadText: view.payloadText,
            reliability: view.reliability,
            ack: view.ack,
            ownership: view.ownership,
            timeoutMs: view.timeoutMs,
            providerMode: view.providerMode,
            canRun: view.canRun,
            actionFeedback: view.actionFeedback
        };
        await render({ ...input, globalValues: { ...input.globalValues, roomId: 'room-b' } });
        const followed = view.contextId;
        await render({ ...input, globalValues: { ...input.globalValues, roomId: 'room-c' } });
        const keptRoom = view.contextId;
        await act(async () => view.setContextId('custom-context'));
        await render({ ...input, authSession: undefined, globalValues: { ...input.globalValues, roomId: 'room-c' } });

        expect({ defaults, followed, keptRoom, kept: view.contextId, activeGroupId: view.activeGroupId, canRunSignedOut: view.canRun }).toEqual({
            defaults: {
                transport: 'realtime',
                laneId: 'realtime',
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                contextId: 'room',
                payloadText: JSON.stringify({ text: 'hello from direct RTC/Realtimes', seq: 1 }, null, 2),
                reliability: 'best-effort',
                ack: 'none',
                ownership: 'shared',
                timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                providerMode: 'browser-rallar',
                canRun: true,
                actionFeedback: { state: 'idle', message: 'Run an RTC/Realtimes operation to see action status.' }
            },
            followed: 'room-b',
            keptRoom: 'room-b',
            kept: 'custom-context',
            activeGroupId: 'room-c',
            canRunSignedOut: false
        });
    });

    it('sends realtime JSON and typed RTC messages through the started and joined facade with the configured fields', async () => {
        await render();
        await configureForm();
        await act(async () => view.sendRealtime());
        await act(async () => view.sendRtcMessage());

        expect({
            configured: facadeCalls.configured,
            defaults: facadeCalls.defaults.at(-1),
            starts: facadeCalls.starts,
            joins: facadeCalls.joins,
            realtimeSends: facadeCalls.realtimeSends,
            rtcSends: facadeCalls.rtcSends,
            result: view.result,
            busyAction: view.busyAction,
            localError: view.localError,
            feedback: { ...view.actionFeedback, durationMs: undefined, atEpochMs: undefined },
            peerIds: view.peerIds,
            phases: recordedPhases()
        }).toEqual({
            configured: [{ apiBaseUrl: 'http://localhost' }, { apiBaseUrl: 'http://localhost' }],
            defaults: {
                applicationId: 'app',
                workspaceId: 'workspace',
                operations: { timeoutMs: 2_500 },
                room: { roomId: 'room-a', roomRef }
            },
            starts: [0, 1].map(() => ({ connect: true, refreshRooms: false, refreshPeople: false, timeoutMs: 2_500 })),
            joins: [0, 1].map(() => ({ groupId: 'room-a', options: { scope: { applicationId: 'app', workspaceId: 'workspace' }, timeoutMs: 2_500 } })),
            realtimeSends: [{ data: { text: 'hello' }, laneId: 'lane-a', roomId: 'room-a', roomRef, peerIds: ['peer-a', 'peer-b'], openTimeoutMs: 2_500 }],
            rtcSends: [{
                roomId: 'room-a',
                roomRef,
                typeId: 'room.custom.message',
                topicId: 'room.custom',
                contextId: 'room-a',
                payload: { text: 'hello' },
                minSnapshotVersion: 7,
                reliability: 'at-least-once',
                ack: 'receiver',
                ownership: 'exclusive',
                nextHopPeerIds: ['peer-a', 'peer-b'],
                overlayId: 'room-a'
            }],
            result: { msgId: 'msg-1' },
            busyAction: undefined,
            localError: undefined,
            feedback: {
                state: 'success',
                label: 'Send RTC message',
                target: 'room-a / realtime',
                status: 'completed',
                message: 'Send RTC message completed.'
            },
            peerIds: ['peer-a', 'peer-b'],
            phases: [
                ...['load-facade:ok', 'configure:ok', 'start:ok', 'join:ok', 'send-realtime-json:ok'],
                'rallar.direct.realtime.send_realtime_json.completed | Send realtime JSON completed',
                ...['load-facade:ok', 'configure:ok', 'start:ok', 'join:ok', 'send-rtc-message:ok'],
                'rallar.direct.realtime.send_rtc_message.completed | Send RTC message completed'
            ]
        });
        expect(runtimeEvents.map(({ event }) => [event.transport, event.actor, event.connection])).toEqual(
            runtimeEvents.map(() => ['realtime', 'user', 'rtc-realtime'])
        );
    });

    it.each([
        {
            activeSessionId: 'session',
            joins: [],
            joinPhase: { status: 'skipped', groupId: 'room-a', reason: 'current browser session is already active in the group' }
        },
        { activeSessionId: 'other-session', joins: ['room-a'], joinPhase: { status: 'ok', groupId: 'room-a' } }
    ])('joins the room only when session $activeSessionId is not already active in it', async ({ activeSessionId, joins, joinPhase }) => {
        currentRoom = { group: { groupId: 'room-a' }, activeSessions: [{ sessionId: activeSessionId }] };
        await render();
        await act(async () => view.sendRealtime());
        const join = runtimeEvents
            .map(({ event }) => event.payload as RallarBlackBoxTestRecord)
            .find((payload) => payload.phase === 'join');

        expect({
            joins: facadeCalls.joins.map((call) => (call as { groupId: string; }).groupId),
            join: {
                ...join,
                durationMs: undefined,
                providerMode: undefined,
                apiBaseUrl: undefined,
                applicationId: undefined,
                workspaceId: undefined,
                roomId: undefined
            }
        }).toEqual({ joins, join: { phase: 'join', ...joinPhase } });
    });

    it.each([
        {
            name: 'simulated provider',
            next: { ...input, bootstrap: { ...input.bootstrap, providerMode: 'simulated' as const } },
            payloadText: '{}',
            error: 'RTC/Realtimes requires provider=browser-rallar.'
        },
        {
            name: 'signed-out browser',
            next: { ...input, authSession: undefined },
            payloadText: '{}',
            error: 'RTC/Realtimes requires a logged-in browser session.'
        },
        { name: 'unparseable payload', next: input, payloadText: '{', error: 'JSON' }
    ])('fails a send for a $name before the facade starts', async ({ next, payloadText, error }) => {
        await render(next);
        await act(async () => view.setPayloadText(payloadText));
        await act(async () => view.sendRealtime());

        expect({
            starts: facadeCalls.starts,
            localError: view.localError?.includes(error),
            feedback: [view.actionFeedback.state, view.actionFeedback.statusText, view.actionFeedback.message?.includes(error)],
            busyAction: view.busyAction,
            events: runtimeEvents.map(({ event, lastAction }) => [event.topic, event.severity, lastAction])
        }).toEqual({
            starts: [],
            localError: true,
            feedback: ['error', 'error', true],
            busyAction: undefined,
            events: [['rallar.direct.realtime.send_realtime_json.failed', 'error', 'Send realtime JSON failed']]
        });
    });

    it('records a rejected facade send as a failed phase and a failed action', async () => {
        realtimeSendFailure = new Error('lane closed');
        await render();
        await act(async () => view.sendRealtime());
        const failedPhase = runtimeEvents
            .map(({ event }) => event.payload as RallarBlackBoxTestRecord)
            .find((payload) => payload.phase === 'send-realtime-json');

        expect({
            localError: view.localError,
            feedback: [view.actionFeedback.state, view.actionFeedback.message],
            failedPhase: [failedPhase?.status, failedPhase?.error],
            failed: runtimeEvents.at(-1)?.event.payload
        }).toEqual({
            localError: 'lane closed',
            feedback: ['error', 'lane closed'],
            failedPhase: ['error', 'lane closed'],
            failed: expect.objectContaining({ error: 'lane closed' })
        });
    });

    it('records realtime and RTC message traffic from the latest subscription of each selector and clears them', async () => {
        await render();
        await act(async () => {
            view.setLaneId('lane-a');
            view.setTypeId('room.custom.message');
            view.setTopicId('room.custom');
            view.setContextId('context-a');
        });
        await act(async () => view.subscribeRealtime());
        await act(async () => view.subscribeRealtime());
        await act(async () => view.subscribeRtcMessages());
        const rtcSubscribeResult = view.result;
        await act(async () => {
            realtimeListeners.forEach((listener) => listener.handler({ peerId: 'peer-a', laneId: 'lane-a', data: { n: 1 }, receivedAtEpochMs: 42 }));
            rtcMessageListeners.forEach((listener) =>
                listener.handler({
                    senderId: 'peer-b',
                    roomId: 'room-a',
                    typeId: 'room.custom.message',
                    topicId: 'room.custom',
                    contextId: 'context-b',
                    payload: { n: 2 }
                })
            );
        });
        const subscribed = {
            realtimeLanes: [...realtimeListeners].map((listener) => listener.laneId),
            rtcSelectors: [...rtcMessageListeners].map((listener) => listener.selector),
            rtcSubscribeResult,
            subscriptions: view.subscriptions.map(({ subscribedAtEpochMs: _at, unsubscribe: _unsubscribe, ...row }) => row),
            received: view.received.map(({ rowId: _rowId, raw: _raw, ...row }) => row),
            messageEvents: runtimeEvents.filter(({ event }) => event.topic === 'rallar.direct.rtc_realtime.message').map(({ lastAction }) => lastAction)
        };
        await act(async () => view.clearSubscriptions());

        expect(subscribed).toEqual({
            realtimeLanes: ['lane-a'],
            rtcSelectors: [{ typeId: 'room.custom.message', topicId: 'room.custom' }],
            rtcSubscribeResult: { subscribed: 'messages.rtc', selector: { typeId: 'room.custom.message', topicId: 'room.custom' } },
            subscriptions: [
                { subscriptionId: 'realtime:room-a:lane-a', transport: 'realtime', label: 'lane lane-a', laneId: 'lane-a', groupId: 'room-a' },
                {
                    subscriptionId: 'messages.rtc:room-a:room.custom:room.custom.message',
                    transport: 'messages.rtc',
                    label: 'room.custom / room.custom.message',
                    laneId: 'lane-a',
                    groupId: 'room-a'
                }
            ],
            received: [
                {
                    atEpochMs: 42,
                    transport: 'realtime',
                    peerId: 'peer-a',
                    laneId: 'lane-a',
                    roomId: 'room-a',
                    typeId: '-',
                    topicId: '-',
                    contextId: 'room-a',
                    payload: { n: 1 }
                },
                {
                    atEpochMs: expect.any(Number),
                    transport: 'messages.rtc',
                    peerId: 'peer-b',
                    laneId: 'lane-a',
                    roomId: 'room-a',
                    typeId: 'room.custom.message',
                    topicId: 'room.custom',
                    contextId: 'context-b',
                    payload: { n: 2 }
                }
            ],
            messageEvents: ['RTC/Realtimes message received', 'RTC/Realtimes message received']
        });
        expect({
            listeners: realtimeListeners.size + rtcMessageListeners.size,
            subscriptions: view.subscriptions,
            feedback: { ...view.actionFeedback, durationMs: undefined, atEpochMs: undefined },
            cleared: runtimeEvents.at(-1)?.lastAction
        }).toEqual({
            listeners: 0,
            subscriptions: [],
            feedback: {
                state: 'success',
                label: 'Clear RTC/Realtimes subscriptions',
                target: 'room-a',
                status: 'cleared',
                message: 'RTC/Realtimes subscriptions cleared.'
            },
            cleared: 'RTC/Realtimes subscriptions cleared'
        });
    });

    it('keeps the fifty most recent received rows', async () => {
        await render();
        await act(async () => view.subscribeRealtime());
        await act(async () => {
            for (let index = 0; index < 52; index += 1) {
                realtimeListeners.forEach((listener) => listener.handler({ peerId: 'peer-a', laneId: 'realtime', data: { index }, receivedAtEpochMs: index }));
            }
        });

        expect(view.received.map((row) => row.atEpochMs)).toEqual(Array.from({ length: 50 }, (_unused, index) => index + 2));
    });

    it('releases every subscription when the panel unmounts under StrictMode', async () => {
        await act(async () =>
            root.render(createElement(
                StrictMode,
                null,
                createElement(RtcRealtimeHarness, {
                    input,
                    capture: (captured) => {
                        view = captured;
                    }
                })
            ))
        );
        await act(async () => view.subscribeRealtime());
        await act(async () => view.subscribeRtcMessages());
        const subscribedListeners = realtimeListeners.size + rtcMessageListeners.size;
        await act(async () => root.unmount());

        expect({ subscribedListeners, remaining: realtimeListeners.size + rtcMessageListeners.size }).toEqual({ subscribedListeners: 2, remaining: 0 });
    });

    it('waits for the room lane and refreshes lane health with the configured lane and peers', async () => {
        await render();
        await configureForm();
        await act(async () => view.waitForRoomLane());
        const waitResult = view.result;
        await act(async () => view.refreshHealth());
        const configuredHealth = view.health;
        await act(async () => {
            view.setLaneId('');
            view.setPeerIdsText('');
        });
        await act(async () => view.refreshHealth());

        expect({ laneWaits: facadeCalls.laneWaits, waitResult, healthReads: facadeCalls.healthReads, configuredHealth, result: view.result }).toEqual({
            laneWaits: [{ ref: roomRef, laneId: 'lane-a', options: { timeoutMs: 2_500 } }],
            waitResult: { ready: true },
            healthReads: [{ peerIds: ['peer-a', 'peer-b'], laneIds: ['lane-a'] }, { peerIds: undefined, laneIds: undefined }],
            configuredHealth: [{ peerId: 'peer-a', laneId: 'lane-a', state: 'open' }],
            result: [{ peerId: 'peer-a', laneId: 'lane-a', state: 'open' }]
        });
    });

    it('shows action feedback and live subscription state in the rendered panel', async () => {
        await act(async () => root.render(createElement(RtcRealtimePanel, input)));
        const metric = (label: string) =>
            [...container.querySelectorAll('.metric')]
                .find((candidate) => candidate.querySelector('span')?.textContent === label)
                ?.querySelector('strong')?.textContent;
        const click = async (name: string) => {
            const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
            await act(async () => button?.click());
        };
        const before = { realtime: metric('Realtime sub'), rtc: metric('RTC message sub') };
        await click('Subscribe realtime');
        await click('Subscribe RTC messages');

        expect({
            before,
            after: { realtime: metric('Realtime sub'), rtc: metric('RTC message sub') },
            feedback: container.querySelector('[aria-live="polite"]')?.textContent?.includes('Subscribe RTC messages completed.')
        }).toEqual({
            before: { realtime: 'no', rtc: 'no' },
            after: { realtime: 'yes', rtc: 'yes' },
            feedback: true
        });
    });

    it.each(CLIPBOARD_FAILURES)('shows $name as a visible error when copying the recipe', async ({ arrange, error }) => {
        await render();
        arrange();
        await act(async () => view.copyRecipe());

        expect(view.localError).toBe(error);
    });
});
