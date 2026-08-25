import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { BrowserRallarCallsController } from '@shared-web/browser/calls/browser-rallar-calls-controller.ts';
import type { RallarMediaPort } from '@shared-web/browser/media/browser-rallar-media-controller.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import type { RallarCallSignalPayload, RallarIncomingCallInvite } from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarMessage, RallarMessageHandler, RallarMessageSendResult } from '@shared-web/browser/rallar-message-contracts.ts';
import type { RallarTargetedChannel, RallarTargetSelector } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade, RallarRtcStatus, RallarRtcWaitForOpenResult } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CallsTestRuntimeInput {
    readonly connect?: () => Promise<ApiMiddleware>;
    readonly resolveTargetPeerIds?: (
        input?: RallarTargetSelector
    ) => readonly string[];
    readonly onSubscribe?: (
        handler: RallarMessageHandler<RallarCallSignalPayload>
    ) => void;
}

describe('BrowserCallSessionRuntime', () => {
    afterEach(() => vi.useRealTimers());

    it('captures fixed membership and start time after connection completes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        let peerIds = ['peer-before-connect'];
        const connect = vi.fn(async () => {
            peerIds = ['peer-after-connect'];
            vi.setSystemTime(250);
            return toTestDouble<ApiMiddleware>({});
        });
        const controller = createCallsController({
            connect,
            resolveTargetPeerIds: () => peerIds
        });

        const call = await controller.operations.start({});

        expect(call.status()).toMatchObject({
            peerIds: ['peer-after-connect'],
            startedAtEpochMs: 250
        });
    });

    it('does not inherit invite room membership into the accepted local call', async () => {
        let inbound: RallarMessageHandler<RallarCallSignalPayload> | undefined;
        const targetInputs: Array<RallarTargetSelector | undefined> = [];
        const invites: RallarIncomingCallInvite[] = [];
        const controller = createCallsController({
            resolveTargetPeerIds: (input) => {
                targetInputs.push(input);
                return ['peer-caller'];
            },
            onSubscribe: (handler) => {
                inbound = handler;
            }
        });
        controller.operations.onInvite((invite) => {
            invites.push(invite);
        });

        await inbound?.(toMessage(toInvitePayload()));
        await invites[0]?.accept();

        expect(targetInputs.at(-1)).toEqual({
            callId: 'call-1',
            peerId: 'peer-caller',
            data: { lanes: ['reliable'] }
        });
    });
});

function createCallsController(
    input: CallsTestRuntimeInput = {}
): BrowserRallarCallsController {
    return new BrowserRallarCallsController({
        connect: input.connect ?? (async () => toTestDouble<ApiMiddleware>({})),
        readMiddleware: () => undefined,
        readSession: () => testSession(),
        requireSession: () => testSession(),
        resolveRoomRef: () => undefined,
        resolveTargetPeerIds: input.resolveTargetPeerIds ?? (() => []),
        createTargetedChannel: <T>() => toTestDouble<RallarTargetedChannel<T>>({}),
        messages: toMessages(input),
        rtc: toTestDouble<RallarRtcFacade>({
            waitForLane: vi.fn(async (peerId, laneId) =>
                toTestDouble<RallarRtcWaitForOpenResult>({
                    transport: 'rtc',
                    status: 'no-peer',
                    peerId,
                    laneId
                })
            ),
            status: vi.fn(() =>
                toTestDouble<RallarRtcStatus>({
                    laneId: 'reliable',
                    knownPeerIds: [],
                    activePeerIds: [],
                    readyPeerIds: [],
                    peers: []
                })
            )
        }),
        media: toTestDouble<RallarMediaFacade>({
            microphone: toTestDouble<RallarMediaFacade['microphone']>({}),
            camera: toTestDouble<RallarMediaFacade['camera']>({}),
            screen: toTestDouble<RallarMediaFacade['screen']>({})
        }),
        mediaController: toTestDouble<RallarMediaPort>({
            readSourceStatus: () => undefined,
            readSourceStatuses: () => []
        }),
        sendWsUnicast: async () => toTestDouble<RallarMessageSendResult>({})
    });
}

function toMessages(input: CallsTestRuntimeInput): RallarMessagesOperations {
    return toTestDouble<RallarMessagesOperations>({
        ws: toTestDouble<RallarMessagesOperations['ws']>({
            onMessage: (_selector, handler) => {
                input.onSubscribe?.(
                    handler as RallarMessageHandler<RallarCallSignalPayload>
                );
                return () => undefined;
            }
        })
    });
}

function toMessage(payload: RallarCallSignalPayload): RallarMessage<RallarCallSignalPayload> {
    return toTestDouble<RallarMessage<RallarCallSignalPayload>>({ payload });
}

function toInvitePayload(): RallarCallSignalPayload {
    return {
        kind: 'invite',
        callId: 'call-1',
        fromPeerId: 'peer-caller',
        toPeerIds: ['session-1'],
        roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        membership: 'live',
        data: { laneIds: ['reliable'] },
        media: {},
        occurredAtEpochMs: 1
    };
}

function testSession(): AuthSession {
    return toTestDouble<AuthSession>({ sessionId: 'session-1' });
}

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
