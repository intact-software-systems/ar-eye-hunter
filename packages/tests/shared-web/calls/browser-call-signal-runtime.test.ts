import { BrowserCallSignalRuntime } from '@shared-web/browser/calls/browser-call-signal-runtime.ts';
import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarMessage, RallarMessageHandler, RallarMessageSendResult } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarCallHandle, RallarCallSignalPayload, RallarIncomingCallInvite } from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarTargetSelector } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, it } from 'vitest';

interface CallSignalTestInput {
    readonly resolveTargetPeerIds?: (
        input?: RallarTargetSelector
    ) => readonly string[];
    readonly onSubscribe?: (
        handler: RallarMessageHandler<RallarCallSignalPayload>
    ) => void;
}

describe('BrowserCallSignalRuntime', () => {
    it('starts an accepted call from the signal target without inheriting room membership', async () => {
        let inbound: RallarMessageHandler<RallarCallSignalPayload> | undefined;
        const startInputs: RallarTargetSelector[] = [];
        const invites: RallarIncomingCallInvite[] = [];
        const runtime = createCallSignalRuntime({
            onSubscribe: (handler) => {
                inbound = handler;
            }
        }, async (input) => {
            startInputs.push(input);
            return toTestDouble<RallarCallHandle>({ id: input.callId ?? 'missing' });
        });
        runtime.onInvite((invite) => {
            invites.push(invite);
        });

        await inbound?.(toMessage(toInvitePayload()));
        await invites[0]?.accept();

        expect(startInputs).toEqual([{
            callId: 'call-1',
            peerId: 'peer-caller',
            data: { lanes: ['reliable'] }
        }]);
    });
});

function createCallSignalRuntime(
    input: CallSignalTestInput,
    startCall: BrowserCallSignalRuntime.Input['startCall']
): BrowserCallSignalRuntime {
    return new BrowserCallSignalRuntime({
        connect: async () => toTestDouble<ApiMiddleware>({}),
        readSession: testSession,
        requireSession: testSession,
        resolveRoomRef: () => undefined,
        resolveTargetPeerIds: input.resolveTargetPeerIds ?? (() => ['peer-caller']),
        messages: toMessages(input),
        readSourceStatus: () => undefined,
        sendWsUnicast: async () => toTestDouble<RallarMessageSendResult>({}),
        startCall
    });
}

function toMessages(input: CallSignalTestInput): RallarMessagesOperations {
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
