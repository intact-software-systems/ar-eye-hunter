// rallar-in-memory-runtime.ts
// deno-lint-ignore-file no-explicit-any
import {
    type RallarRtcClientArgs,
    type RallarRtcClientEventDispatcher,
    type RallarRtcRuntime,
    type RallarRtcRuntimeSession
} from './rallar-rtc-provider.ts';
import { createRallarWebRtcProvider } from './rallar-webrtc-runtime.ts';
import type { RtcProvider } from './rtc-provider.ts';

export interface RallarInMemoryRuntimeConnection {
    args: RallarRtcClientArgs;
    dispatcher: RallarRtcClientEventDispatcher;
    connectedAtEpochMs: number;
    closed: boolean;
}

export interface RallarInMemoryRuntimeState {
    connections: Map<string, RallarInMemoryRuntimeConnection>;
    nextDeliverySequence: number;
}

export function createRallarInMemoryRuntimeState(): RallarInMemoryRuntimeState {
    return {
        connections: new Map<string, RallarInMemoryRuntimeConnection>(),
        nextDeliverySequence: 1
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

    return message?.toPeerId ||
        message?.targetPeerId ||
        message?.to ||
        message?.payload?.toPeerId ||
        message?.payload?.targetPeerId ||
        message?.payload?.to ||
        args.remotePeerId;
}

interface InMemoryDeliveryInput {
    readonly deliverySequence: number;
    readonly message: any;
    readonly sender: RallarInMemoryRuntimeConnection;
    readonly target: RallarInMemoryRuntimeConnection;
    readonly deliveryMode: 'direct' | 'broadcast';
    readonly sentAtEpochMs: number;
}

function toDeliveryEnvelope(input: InMemoryDeliveryInput): any {
    const { deliverySequence, message, sender, target, deliveryMode, sentAtEpochMs } = input;
    return {
        ...message,
        deliveredBy: 'rallar-in-memory-runtime',
        deliveryMode,
        deliverySequence,
        deliveryGroup: toGroupKey(sender.args),
        sentBy: toPeerKey(sender.args),
        deliveredTo: toPeerKey(target.args),
        sentAtEpochMs
    };
}

function toBroadcastTargets(
    state: RallarInMemoryRuntimeState,
    sender: RallarInMemoryRuntimeConnection
): RallarInMemoryRuntimeConnection[] {
    const senderPeerKey = toPeerKey(sender.args);
    const senderGroupKey = toGroupKey(sender.args);

    return Array.from(state.connections.values())
        .filter((connection) => !connection.closed)
        .filter((connection) => toPeerKey(connection.args) !== senderPeerKey)
        .filter((connection) => senderGroupKey === undefined || toGroupKey(connection.args) === senderGroupKey);
}

export interface RallarInMemoryRuntimeInput {
    readonly state: RallarInMemoryRuntimeState;
    readonly now: () => number;
}

export function createRallarInMemoryRuntime(input: RallarInMemoryRuntimeInput): RallarRtcRuntime {
    const { state, now } = input;
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
                connectedAtEpochMs: now(),
                closed: false
            };

            state.connections.set(peerKey, connection);

            return {
                send: (message) => deliverInMemoryMessage({ state, now, message, sender: connection }),

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
                        overlayId: args.overlayId
                    });
                }
            };
        }
    };
}

interface DeliverInMemoryMessageInput extends RallarInMemoryRuntimeInput {
    readonly message: any;
    readonly sender: RallarInMemoryRuntimeConnection;
}

function deliverInMemoryMessage(input: DeliverInMemoryMessageInput): void {
    const { state, now, message, sender } = input;
    const targetPeerKey = toTargetPeerKey(message, sender.args);
    const deliveryMode = targetPeerKey === undefined ? 'broadcast' : 'direct';
    let targets: RallarInMemoryRuntimeConnection[];
    if (targetPeerKey !== undefined) {
        const target = state.connections.get(String(targetPeerKey));
        if (!target || target.closed) {
            throw new Error('Rallar in-memory RTC target is not connected: ' + String(targetPeerKey));
        }
        targets = [target];
    }
    else {
        targets = toBroadcastTargets(state, sender);
        if (targets.length <= 0) {
            throw new Error(
                'Rallar in-memory RTC broadcast has no connected targets for peer: ' + toPeerKey(sender.args)
            );
        }
    }
    for (const target of targets) {
        const deliverySequence = nextDeliverySequence(state);
        const sentAtEpochMs = now();
        target.dispatcher.emitMessage(
            toDeliveryEnvelope({ message, sender, target, deliveryMode, deliverySequence, sentAtEpochMs })
        );
    }
}

/**
 * Deterministic in-memory provider used for black-box scenarios that need
 * multi-peer routing without real WebSocket or WebRTC transports.
 */
export function createRallarInMemoryProvider(input: RallarInMemoryRuntimeInput): RtcProvider {
    const runtime = createRallarInMemoryRuntime(input);

    return createRallarWebRtcProvider({
        createSession: runtime.connect
    });
}
