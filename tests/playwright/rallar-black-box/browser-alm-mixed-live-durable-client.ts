import type { RallarMessage } from '../../../packages/shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRealtimeMessage } from '../../../packages/shared-web/browser/rallar-realtime-facade.ts';
import { rallar } from '../../../packages/shared-web/browser/rallar.ts';
import type { GroupRef } from '../../../packages/shared/api/group-types.ts';

import {
    readMixedLiveDurableObservation,
    type MixedLiveDurableObservation,
    type MixedLiveDurableObservationSnapshot
} from './browser-alm-mixed-live-durable-observer.ts';

export interface MixedLivePayload {
    readonly identity: string;
    readonly sequence: number;
    readonly sentAtEpochMs: number;
    readonly probeOverlap: boolean;
    readonly roomRef: GroupRef;
}

export interface MixedDurablePayload {
    readonly identity: string;
    readonly sentAtEpochMs: number;
}

export interface MixedReceiverProgress {
    readonly durableMessageIds: readonly string[];
    readonly liveSequences: readonly number[];
    readonly postReconnectReceived: boolean;
}

export interface InstallMixedReceiverInput {
    readonly roomId: string;
    readonly durableTopicId: string;
    readonly durableTypeId: string;
    readonly liveLaneId: string;
    readonly timeoutMs: number;
}

export interface MixedClientCleanupFailure {
    readonly stage: 'receiver-unsubscribe' | 'rallar-disconnect' | 'observation-dispose';
    readonly name: string;
}

export interface MixedClientCleanup {
    readonly observation: MixedLiveDurableObservationSnapshot | null;
    readonly failures: readonly MixedClientCleanupFailure[];
}

interface MixedReceiverState {
    readonly durableMessageIds: string[];
    readonly liveSequences: number[];
    readonly unsubscribers: readonly (() => void)[];
    readPostReconnectReceived(): boolean;
}

interface ObserveDurableMessageInput {
    readonly roomRef: GroupRef;
    readonly observation: MixedLiveDurableObservation;
    readonly durableMessageIds: string[];
    readonly payload: MixedDurablePayload;
    readonly message: RallarMessage<MixedDurablePayload>;
}

interface ObserveLiveMessageInput {
    readonly roomRef: GroupRef;
    readonly observation: MixedLiveDurableObservation;
    readonly liveSequences: number[];
    readonly postReconnectState: { received: boolean; };
    readonly message: RallarRealtimeMessage<MixedLivePayload>;
}

declare global {
    interface Window {
        __rallarMixedReceiver?: MixedReceiverState;
    }
}

export async function installMixedLiveDurableReceiver(input: InstallMixedReceiverInput): Promise<void> {
    await rallar.rooms.join(input.roomId, { timeoutMs: input.timeoutMs, maxAttempts: 3 });
    const room = rallar.rooms.session(input.roomId);
    const observation = readMixedLiveDurableObservation();
    const durableMessageIds: string[] = [];
    const liveSequences: number[] = [];
    const postReconnectState = { received: false };
    const unsubscribeDurable = room.message<MixedDurablePayload>({
        topicId: input.durableTopicId,
        typeId: input.durableTypeId
    }).onRtc((payload, message) => {
        observeDurableMessage({ roomRef: room.roomRef, observation, durableMessageIds, payload, message });
    });
    const unsubscribeLive = room.realtime<MixedLivePayload>(input.liveLaneId).on((message) => {
        observeLiveMessage({ roomRef: room.roomRef, observation, liveSequences, postReconnectState, message });
    });
    window.__rallarMixedReceiver = {
        durableMessageIds,
        liveSequences,
        unsubscribers: [unsubscribeDurable, unsubscribeLive],
        readPostReconnectReceived: () => postReconnectState.received
    };
}

export function readMixedLiveDurableReceiverProgress(): MixedReceiverProgress {
    const receiver = window.__rallarMixedReceiver;
    if (receiver === undefined) {
        throw new Error('Mixed live/durable receiver subscription is missing');
    }
    return {
        durableMessageIds: [...receiver.durableMessageIds],
        liveSequences: [...receiver.liveSequences],
        postReconnectReceived: receiver.readPostReconnectReceived()
    };
}

export async function disposeMixedLiveDurableClient(): Promise<MixedClientCleanup> {
    const failures: MixedClientCleanupFailure[] = [];
    disposeReceiverSubscriptions(failures);
    try {
        await rallar.disconnect();
    }
    catch (error) {
        failures.push({
            stage: 'rallar-disconnect',
            name: error instanceof Error ? error.name : 'UnknownFailure'
        });
    }
    let observation: MixedLiveDurableObservationSnapshot | null = null;
    try {
        observation = readMixedLiveDurableObservation().dispose();
    }
    catch (error) {
        failures.push({
            stage: 'observation-dispose',
            name: error instanceof Error ? error.name : 'UnknownFailure'
        });
    }
    return { observation, failures };
}

function disposeReceiverSubscriptions(failures: MixedClientCleanupFailure[]): void {
    const receiver = window.__rallarMixedReceiver;
    delete window.__rallarMixedReceiver;
    for (const unsubscribe of receiver?.unsubscribers ?? []) {
        try {
            unsubscribe();
        }
        catch (error) {
            failures.push({
                stage: 'receiver-unsubscribe',
                name: error instanceof Error ? error.name : 'UnknownFailure'
            });
        }
    }
}

function observeDurableMessage(input: ObserveDurableMessageInput): void {
    const { roomRef, observation, durableMessageIds, payload, message } = input;
    const target = message.raw.targets;
    if (target === undefined || target.mode !== 'multicast' || !sameRoom(target.groupRef, roomRef)) {
        return;
    }
    durableMessageIds.push(message.raw.id.msgId);
    observation.observeDurableCallback({
        identity: message.raw.id.msgId,
        sentAtEpochMs: payload.sentAtEpochMs,
        receivedAtEpochMs: message.receivedAtEpochMs
    });
}

function observeLiveMessage(input: ObserveLiveMessageInput): void {
    const { roomRef, observation, liveSequences, postReconnectState, message } = input;
    if (!sameRoom(message.data.roomRef, roomRef)) {
        return;
    }
    liveSequences.push(message.data.sequence);
    postReconnectState.received ||= message.data.identity === 'post-reconnect';
    observation.observeLiveMessage({
        identity: message.data.identity,
        sequence: message.data.sequence,
        sentAtEpochMs: message.data.sentAtEpochMs,
        receivedAtEpochMs: message.receivedAtEpochMs,
        markedForOverlap: message.data.probeOverlap
    });
}

function sameRoom(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}
