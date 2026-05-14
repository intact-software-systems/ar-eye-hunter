// rallar-in-memory-runtime.ts
// deno-lint-ignore-file no-explicit-any
import {
    type RallarRtcClientArgs,
    type RallarRtcClientEventDispatcher,
    type RallarRtcRuntime,
    type RallarRtcRuntimeSession,
} from './rallar-rtc-provider.ts';
import { createRallarWebRtcProvider } from './rallar-webrtc-runtime.ts';
import type { RtcProvider } from './rtc-provider.ts';

export type RallarInMemoryRuntimeConnection = {
    args: RallarRtcClientArgs
    dispatcher: RallarRtcClientEventDispatcher
    connectedAtEpochMs: number
    closed: boolean
}

export type RallarInMemoryRuntimeState = {
    connections: Map<string, RallarInMemoryRuntimeConnection>
    nextDeliverySequence: number
}

export function createRallarInMemoryRuntimeState(): RallarInMemoryRuntimeState {
    return {
        connections: new Map<string, RallarInMemoryRuntimeConnection>(),
        nextDeliverySequence: 1,
    };
}

function nextDeliverySequence(state: RallarInMemoryRuntimeState): number {
    const sequence = state.nextDeliverySequence;
    state.nextDeliverySequence += 1;
    return sequence;
}

function toPeerKey(args: RallarRtcClientArgs): string {
    return args.peerId || args.actor || args.connection;
}

function toGroupKey(args: RallarRtcClientArgs): string | undefined {
    return args.groupId || args.overlayId || args.roomId;
}

function isBroadcastMessage(message: any): boolean {
    return message?.broadcast === true || message?.payload?.broadcast === true;
}

function toTargetPeerKey(message: any, args: RallarRtcClientArgs): string | undefined {
    if (isBroadcastMessage(message)) {
        return undefined;
    }

    return message?.toPeerId
        || message?.targetPeerId
        || message?.to
        || message?.payload?.toPeerId
        || message?.payload?.targetPeerId
        || message?.payload?.to
        || args.remotePeerId;
}

function toDeliveryEnvelope(
    state: RallarInMemoryRuntimeState,
    message: any,
    sender: RallarInMemoryRuntimeConnection,
    target: RallarInMemoryRuntimeConnection,
    deliveryMode: 'direct' | 'broadcast',
): any {
    return {
        ...message,
        deliveredBy: 'rallar-in-memory-runtime',
        deliveryMode,
        deliverySequence: nextDeliverySequence(state),
        deliveryGroup: toGroupKey(sender.args),
        sentBy: toPeerKey(sender.args),
        deliveredTo: toPeerKey(target.args),
        sentAtEpochMs: Date.now(),
    };
}

function toBroadcastTargets(
    state: RallarInMemoryRuntimeState,
    sender: RallarInMemoryRuntimeConnection,
): RallarInMemoryRuntimeConnection[] {
    const senderPeerKey = toPeerKey(sender.args);
    const senderGroupKey = toGroupKey(sender.args);

    return Array.from(state.connections.values())
        .filter(connection => !connection.closed)
        .filter(connection => toPeerKey(connection.args) !== senderPeerKey)
        .filter(connection => senderGroupKey === undefined || toGroupKey(connection.args) === senderGroupKey);
}

export function createRallarInMemoryRuntime(
    state: RallarInMemoryRuntimeState = createRallarInMemoryRuntimeState(),
): RallarRtcRuntime {
    return {
        connect: (args, dispatcher): RallarRtcRuntimeSession => {
            const peerKey = toPeerKey(args);
            const existingConnection = state.connections.get(peerKey);

            if (existingConnection && !existingConnection.closed) {
                throw new Error('Rallar in-memory RTC peer is already connected: ' + peerKey);
            }

            const connection: RallarInMemoryRuntimeConnection = {
                args,
                dispatcher,
                connectedAtEpochMs: Date.now(),
                closed: false,
            };

            state.connections.set(peerKey, connection);

            return {
                send: message => {
                    const targetPeerKey = toTargetPeerKey(message, args);

                    if (targetPeerKey !== undefined) {
                        const target = state.connections.get(String(targetPeerKey));

                        if (!target || target.closed) {
                            throw new Error(
                                'Rallar in-memory RTC target is not connected: ' + String(targetPeerKey),
                            );
                        }

                        target.dispatcher.emitMessage(toDeliveryEnvelope(state, message, connection, target, 'direct'));
                        return;
                    }

                    const targets = toBroadcastTargets(state, connection);

                    if (targets.length <= 0) {
                        throw new Error(
                            'Rallar in-memory RTC broadcast has no connected targets for peer: ' + toPeerKey(args),
                        );
                    }

                    targets.forEach(target => {
                        target.dispatcher.emitMessage(toDeliveryEnvelope(state, message, connection, target, 'broadcast'));
                    });
                },

                close: () => {
                    connection.closed = true;
                    state.connections.delete(peerKey);
                    dispatcher.emitClose({
                        phase: 'close',
                        reason: 'closed by rallar in-memory runtime',
                        closedBy: 'rallar-in-memory-runtime',
                        connection: args.connection,
                        actor: args.actor,
                        peerId: peerKey,
                        roomId: args.roomId,
                        groupId: args.groupId,
                        overlayId: args.overlayId,
                    });
                },
            };
        },
    };
}

/**
 * Deterministic in-memory provider used for black-box scenarios that need
 * multi-peer routing without real WebSocket or WebRTC transports.
 */
export function createRallarInMemoryProvider(
    state: RallarInMemoryRuntimeState = createRallarInMemoryRuntimeState(),
): RtcProvider {
    const runtime = createRallarInMemoryRuntime(state);

    return createRallarWebRtcProvider({
        createSession: runtime.connect,
    });
}