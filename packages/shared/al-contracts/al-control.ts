import { NEVER_EXPIRE_AT_TIMESTAMP, type PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import {
    computeALUnicastMessage,
    type ALMessage,
    type ALMessageConstructionFacts,
    type ALRoute
} from './al-contract.ts';
import type { ALOrderingObservation, ALReadyable } from './al-runtime.ts';

export const AL_CONTROL_ACK_TYPE_ID = 'al.control.ack.v1';
export const AL_CONTROL_NACK_TYPE_ID = 'al.control.nack.v1';
export const AL_CONTROL_REPAIR_TYPE_ID = 'al.control.repair.v1';

export type ALAckStatus = 'accepted' | 'delivered' | 'forwarded' | 'subtree-complete';
export type ALNackReason =
    | 'duplicate'
    | 'gap'
    | 'expired'
    | 'unauthorized'
    | 'no-route'
    | 'overloaded'
    | 'stale'
    | 'not-yet-in-sync';
export type ALRepairReason = 'missing-seq' | 'retransmit' | 'resync';

export interface ALControlMessageConstructionFacts extends ALMessageConstructionFacts {
    readonly observedAtEpochMs: number;
}

export type ALAckPayload = Readonly<{
    ackedMsgId: string;
    fromPeerId: string;
    toPeerId: string;
    status: ALAckStatus;
    observedAtEpochMs: number;
}>;

export type ALNackPayload = Readonly<{
    msgId: string;
    fromPeerId: string;
    toPeerId: string;
    reason: ALNackReason;
    observedAtEpochMs: number;
    orderingKey?: string;
    expectedSeq?: number;
    missingSeqs?: readonly number[];
    serverSnapshotVersion?: number;
}>;

export type ALRepairPayload = Readonly<{
    msgId: string;
    fromPeerId: string;
    toPeerId: string;
    reason: ALRepairReason;
    observedAtEpochMs: number;
    orderingKey?: string;
    expectedSeq?: number;
    missingSeqs?: readonly number[];
}>;

export type ALControlPayload = ALAckPayload | ALNackPayload | ALRepairPayload;

export type ALParsedControlMessage =
    | Readonly<{
        type: 'ack';
        payload: ALAckPayload;
    }>
    | Readonly<{
        type: 'nack';
        payload: ALNackPayload;
    }>
    | Readonly<{
        type: 'repair';
        payload: ALRepairPayload;
    }>;

export type ALControlEvent = Readonly<{
    acks: readonly ALAckPayload[];
    nacks: readonly ALNackPayload[];
    repairs: readonly ALRepairPayload[];
}>;

export type ALCompletedPendingAck = Readonly<{
    msgId: string;
    toPeerId: string;
    status: ALAckStatus;
    expireAtTimestamp?: number;
}>;

export type ALControlAcceptance = Readonly<{
    handled: boolean;
    completedPendingAcks: readonly ALCompletedPendingAck[];
}>;

export interface ALControlTrackerLike {
    read(msgId: string): ALControlEvent;

    readPendingAck(msgId: string): {
        toPeerId: string;
        status: ALAckStatus;
        localReady: boolean;
        expectedFromPeerIds: readonly string[];
        ackedFromPeerIds: readonly string[];
    } | undefined;
}

export interface ALControlTracker extends ALControlTrackerLike, ALReadyable {
    accept(msg: ALMessage): Promise<ALControlAcceptance>;

    trackPendingAck(
        msgId: string,
        toPeerId: string,
        status: ALAckStatus,
        expectedFromPeerIds?: readonly string[],
        localReady?: boolean
    ): Promise<ALCompletedPendingAck | undefined>;

    markPendingAckLocalReady(msgId: string): Promise<ALCompletedPendingAck | undefined>;

    clearPendingAck(msgId: string): Promise<boolean>;
}

export function isALControlTypeId(typeId: string): boolean {
    return typeId === AL_CONTROL_ACK_TYPE_ID ||
        typeId === AL_CONTROL_NACK_TYPE_ID ||
        typeId === AL_CONTROL_REPAIR_TYPE_ID;
}

export function parseALControlMessage(
    msg: ALMessage
): ALParsedControlMessage | undefined {
    switch (msg.payload.typeId) {
        case AL_CONTROL_ACK_TYPE_ID:
            return {
                type: 'ack',
                payload: JSON.parse(msg.payload.resource) as ALAckPayload
            };
        case AL_CONTROL_NACK_TYPE_ID:
            return {
                type: 'nack',
                payload: JSON.parse(msg.payload.resource) as ALNackPayload
            };
        case AL_CONTROL_REPAIR_TYPE_ID:
            return {
                type: 'repair',
                payload: JSON.parse(msg.payload.resource) as ALRepairPayload
            };
        default:
            return undefined;
    }
}

export function newALAckControlMessage(
    senderId: string,
    toPeerId: string,
    ackedMsgId: string,
    status: ALAckStatus = 'accepted'
): ALMessage {
    const nowEpochMs = Date.now();
    return computeALAckControlMessage(
        senderId,
        toPeerId,
        ackedMsgId,
        status,
        { msgId: crypto.randomUUID(), nowEpochMs, observedAtEpochMs: nowEpochMs }
    );
}

export function computeALAckControlMessage(
    senderId: string,
    toPeerId: string,
    ackedMsgId: string,
    status: ALAckStatus,
    facts: ALControlMessageConstructionFacts
): ALMessage {
    const payload: ALAckPayload = {
        ackedMsgId,
        fromPeerId: senderId,
        toPeerId,
        status,
        observedAtEpochMs: facts.observedAtEpochMs
    };

    return computeALUnicastMessage(
        senderId,
        toControlRoute(senderId, toPeerId, ackedMsgId, AL_CONTROL_ACK_TYPE_ID),
        toPeerId,
        AL_CONTROL_ACK_TYPE_ID,
        payload,
        facts,
        {
            qos: {
                delivery: {
                    algo: 'best-effort'
                },
                durability: {
                    algo: 'volatile'
                },
                ack: {
                    algo: 'none',
                    opts: {
                        timeoutMs: 250
                    }
                }
            }
        }
    );
}

export function newALNackControlMessage(
    senderId: string,
    toPeerId: string,
    msgId: string,
    reason: ALNackReason,
    ordering?: ALOrderingObservation,
    options: Readonly<{
        serverSnapshotVersion?: number;
    }> = {}
): ALMessage {
    const nowEpochMs = Date.now();
    return computeALNackControlMessage(
        senderId,
        toPeerId,
        msgId,
        reason,
        ordering,
        options,
        { msgId: crypto.randomUUID(), nowEpochMs, observedAtEpochMs: nowEpochMs }
    );
}

export function computeALNackControlMessage(
    senderId: string,
    toPeerId: string,
    msgId: string,
    reason: ALNackReason,
    ordering: ALOrderingObservation | undefined,
    options: Readonly<{ serverSnapshotVersion?: number; }>,
    facts: ALControlMessageConstructionFacts
): ALMessage {
    const payload: ALNackPayload = {
        msgId,
        fromPeerId: senderId,
        toPeerId,
        reason,
        observedAtEpochMs: facts.observedAtEpochMs,
        orderingKey: ordering?.trackKey,
        expectedSeq: ordering?.expectedSeq,
        missingSeqs: ordering?.missingSeqs,
        serverSnapshotVersion: options.serverSnapshotVersion
    };

    return computeALUnicastMessage(
        senderId,
        toControlRoute(senderId, toPeerId, msgId, AL_CONTROL_NACK_TYPE_ID),
        toPeerId,
        AL_CONTROL_NACK_TYPE_ID,
        payload,
        facts,
        {
            qos: {
                delivery: {
                    algo: 'at-least-once'
                },
                durability: {
                    algo: 'local-outbox'
                },
                retry: {
                    algo: 'exp-backoff',
                    opts: {
                        maxAttempts: 3
                    }
                },
                ack: {
                    algo: 'none',
                    opts: {
                        timeoutMs: 250
                    }
                }
            }
        }
    );
}

export function newALRepairControlMessage(
    senderId: string,
    toPeerId: string,
    msgId: string,
    reason: ALRepairReason,
    ordering?: ALOrderingObservation
): ALMessage {
    const nowEpochMs = Date.now();
    return computeALRepairControlMessage(
        senderId,
        toPeerId,
        msgId,
        reason,
        ordering,
        { msgId: crypto.randomUUID(), nowEpochMs, observedAtEpochMs: nowEpochMs }
    );
}

export function computeALRepairControlMessage(
    senderId: string,
    toPeerId: string,
    msgId: string,
    reason: ALRepairReason,
    ordering: ALOrderingObservation | undefined,
    facts: ALControlMessageConstructionFacts
): ALMessage {
    const payload: ALRepairPayload = {
        msgId,
        fromPeerId: senderId,
        toPeerId,
        reason,
        observedAtEpochMs: facts.observedAtEpochMs,
        orderingKey: ordering?.trackKey,
        expectedSeq: ordering?.expectedSeq,
        missingSeqs: ordering?.missingSeqs
    };

    return computeALUnicastMessage(
        senderId,
        toControlRoute(senderId, toPeerId, msgId, AL_CONTROL_REPAIR_TYPE_ID),
        toPeerId,
        AL_CONTROL_REPAIR_TYPE_ID,
        payload,
        facts,
        {
            qos: {
                delivery: {
                    algo: 'at-least-once'
                },
                durability: {
                    algo: 'local-outbox'
                },
                retry: {
                    algo: 'exp-backoff',
                    opts: {
                        maxAttempts: 3
                    }
                },
                ack: {
                    algo: 'none',
                    opts: {
                        timeoutMs: 250
                    }
                }
            }
        }
    );
}

type ALPendingAckState = {
    toPeerId: string;
    status: ALAckStatus;
    localReady: boolean;
    expectedFromPeerIds: Set<string>;
    ackedFromPeerIds: Set<string>;
};

type PersistedALPendingAckState = Readonly<{
    toPeerId: string;
    status: ALAckStatus;
    localReady: boolean;
    expectedFromPeerIds: readonly string[];
    ackedFromPeerIds: readonly string[];
    expireAtTimestamp?: number;
}>;

export type ALPendingAckSnapshot = PersistedALPendingAckState;

type PersistedALControlValue =
    | Readonly<{
        kind: 'acks';
        values: readonly ALAckPayload[];
    }>
    | Readonly<{
        kind: 'nacks';
        values: readonly ALNackPayload[];
    }>
    | Readonly<{
        kind: 'repairs';
        values: readonly ALRepairPayload[];
    }>
    | Readonly<{
        kind: 'pending';
        value: PersistedALPendingAckState;
    }>;

export type ALControlPersistenceValue = PersistedALControlValue;

export class InMemoryALControlTracker implements ALControlTracker {
    private readonly acksByMsgId = new Map<string, ALAckPayload[]>();
    private readonly nacksByMsgId = new Map<string, ALNackPayload[]>();
    private readonly repairsByMsgId = new Map<string, ALRepairPayload[]>();
    private readonly pendingAckByMsgId = new Map<string, ALPendingAckState>();

    async ready(): Promise<void> {
    }

    async accept(msg: ALMessage): Promise<ALControlAcceptance> {
        switch (msg.payload.typeId) {
            case AL_CONTROL_ACK_TYPE_ID:
                return this.recordAck(JSON.parse(msg.payload.resource) as ALAckPayload);
            case AL_CONTROL_NACK_TYPE_ID:
                this.recordNack(JSON.parse(msg.payload.resource) as ALNackPayload);
                return {
                    handled: true,
                    completedPendingAcks: []
                };
            case AL_CONTROL_REPAIR_TYPE_ID:
                this.recordRepair(JSON.parse(msg.payload.resource) as ALRepairPayload);
                return {
                    handled: true,
                    completedPendingAcks: []
                };
            default:
                return {
                    handled: false,
                    completedPendingAcks: []
                };
        }
    }

    read(msgId: string): ALControlEvent {
        return {
            acks: this.acksByMsgId.get(msgId) ?? [],
            nacks: this.nacksByMsgId.get(msgId) ?? [],
            repairs: this.repairsByMsgId.get(msgId) ?? []
        };
    }

    trackPendingAck(
        msgId: string,
        toPeerId: string,
        status: ALAckStatus,
        expectedFromPeerIds: readonly string[] = [],
        localReady: boolean = false
    ): Promise<ALCompletedPendingAck | undefined> {
        const current = this.pendingAckByMsgId.get(msgId);
        const next = current
            ? {
                ...current,
                toPeerId,
                status,
                localReady: current.localReady || localReady
            }
            : {
                toPeerId,
                status,
                localReady,
                expectedFromPeerIds: new Set<string>(expectedFromPeerIds),
                ackedFromPeerIds: new Set<string>()
            };

        for (const peerId of expectedFromPeerIds) {
            next.expectedFromPeerIds.add(peerId);
        }

        this.pendingAckByMsgId.set(msgId, next);
        return Promise.resolve(this.tryCompletePendingAck(msgId));
    }

    readPendingAck(msgId: string): {
        toPeerId: string;
        status: ALAckStatus;
        localReady: boolean;
        expectedFromPeerIds: readonly string[];
        ackedFromPeerIds: readonly string[];
    } | undefined {
        const pending = this.pendingAckByMsgId.get(msgId);
        if (!pending) {
            return undefined;
        }

        return {
            toPeerId: pending.toPeerId,
            status: pending.status,
            localReady: pending.localReady,
            expectedFromPeerIds: [...pending.expectedFromPeerIds],
            ackedFromPeerIds: [...pending.ackedFromPeerIds]
        };
    }

    markPendingAckLocalReady(msgId: string): Promise<ALCompletedPendingAck | undefined> {
        const pending = this.pendingAckByMsgId.get(msgId);
        if (!pending) {
            return Promise.resolve(undefined);
        }

        pending.localReady = true;
        return Promise.resolve(this.tryCompletePendingAck(msgId));
    }

    clearPendingAck(msgId: string): Promise<boolean> {
        return Promise.resolve(this.pendingAckByMsgId.delete(msgId));
    }

    private recordAck(payload: ALAckPayload): ALControlAcceptance {
        this.push(this.acksByMsgId, payload.ackedMsgId, payload);

        const pending = this.pendingAckByMsgId.get(payload.ackedMsgId);
        if (!pending) {
            return {
                handled: true,
                completedPendingAcks: []
            };
        }

        if (
            pending.expectedFromPeerIds.size === 0 ||
            pending.expectedFromPeerIds.has(payload.fromPeerId)
        ) {
            pending.ackedFromPeerIds.add(payload.fromPeerId);
        }

        const completed = this.tryCompletePendingAck(payload.ackedMsgId);
        return {
            handled: true,
            completedPendingAcks: completed ? [completed] : []
        };
    }

    private tryCompletePendingAck(msgId: string): ALCompletedPendingAck | undefined {
        const pending = this.pendingAckByMsgId.get(msgId);
        if (!pending || !pending.localReady) {
            return undefined;
        }

        const isComplete = pending.expectedFromPeerIds.size === 0 ||
            [...pending.expectedFromPeerIds].every((peerId) => pending.ackedFromPeerIds.has(peerId));

        if (!isComplete) {
            return undefined;
        }

        this.pendingAckByMsgId.delete(msgId);
        return {
            msgId,
            toPeerId: pending.toPeerId,
            status: pending.status
        };
    }

    private recordNack(payload: ALNackPayload): void {
        this.push(this.nacksByMsgId, payload.msgId, payload);
    }

    private recordRepair(payload: ALRepairPayload): void {
        this.push(this.repairsByMsgId, payload.msgId, payload);
    }

    private push<T>(
        target: Map<string, T[]>,
        key: string,
        payload: T
    ): void {
        const values = target.get(key) ?? [];
        values.push(payload);
        target.set(key, values);
    }
}

export class PersistentALControlTracker implements ALControlTracker {
    private readonly acksByMsgId = new Map<string, ALAckPayload[]>();
    private readonly nacksByMsgId = new Map<string, ALNackPayload[]>();
    private readonly repairsByMsgId = new Map<string, ALRepairPayload[]>();
    private readonly pendingAckByMsgId = new Map<string, ALPendingAckState>();
    private readonly readyPromise: Promise<void>;
    private hydrated = false;

    private readonly persistence: PersistenceProvider<string, PersistedALControlValue>;

    constructor(
        persistence: PersistenceProvider<string, PersistedALControlValue>
    ) {
        this.persistence = persistence;
        this.readyPromise = this.hydrate();
    }

    async ready(): Promise<void> {
        await this.readyPromise;
    }

    async accept(msg: ALMessage): Promise<ALControlAcceptance> {
        await this.ready();

        switch (msg.payload.typeId) {
            case AL_CONTROL_ACK_TYPE_ID:
                return await this.recordAck(JSON.parse(msg.payload.resource) as ALAckPayload);
            case AL_CONTROL_NACK_TYPE_ID:
                await this.recordNack(JSON.parse(msg.payload.resource) as ALNackPayload);
                return {
                    handled: true,
                    completedPendingAcks: []
                };
            case AL_CONTROL_REPAIR_TYPE_ID:
                await this.recordRepair(JSON.parse(msg.payload.resource) as ALRepairPayload);
                return {
                    handled: true,
                    completedPendingAcks: []
                };
            default:
                return {
                    handled: false,
                    completedPendingAcks: []
                };
        }
    }

    read(msgId: string): ALControlEvent {
        this.assertReady();

        return {
            acks: this.acksByMsgId.get(msgId) ?? [],
            nacks: this.nacksByMsgId.get(msgId) ?? [],
            repairs: this.repairsByMsgId.get(msgId) ?? []
        };
    }

    async trackPendingAck(
        msgId: string,
        toPeerId: string,
        status: ALAckStatus,
        expectedFromPeerIds: readonly string[] = [],
        localReady: boolean = false
    ): Promise<ALCompletedPendingAck | undefined> {
        await this.ready();

        const current = this.pendingAckByMsgId.get(msgId);
        const next = current
            ? {
                ...current,
                toPeerId,
                status,
                localReady: current.localReady || localReady
            }
            : {
                toPeerId,
                status,
                localReady,
                expectedFromPeerIds: new Set<string>(expectedFromPeerIds),
                ackedFromPeerIds: new Set<string>()
            };

        for (const peerId of expectedFromPeerIds) {
            next.expectedFromPeerIds.add(peerId);
        }

        this.pendingAckByMsgId.set(msgId, next);

        const completed = await this.tryCompletePendingAck(msgId);
        if (!completed) {
            await this.persistPendingAck(msgId, next);
        }

        return completed;
    }

    readPendingAck(msgId: string): {
        toPeerId: string;
        status: ALAckStatus;
        localReady: boolean;
        expectedFromPeerIds: readonly string[];
        ackedFromPeerIds: readonly string[];
    } | undefined {
        this.assertReady();

        const pending = this.pendingAckByMsgId.get(msgId);
        if (!pending) {
            return undefined;
        }

        return {
            toPeerId: pending.toPeerId,
            status: pending.status,
            localReady: pending.localReady,
            expectedFromPeerIds: [...pending.expectedFromPeerIds],
            ackedFromPeerIds: [...pending.ackedFromPeerIds]
        };
    }

    async markPendingAckLocalReady(msgId: string): Promise<ALCompletedPendingAck | undefined> {
        await this.ready();

        const pending = this.pendingAckByMsgId.get(msgId);
        if (!pending) {
            return undefined;
        }

        pending.localReady = true;

        const completed = await this.tryCompletePendingAck(msgId);
        if (!completed) {
            await this.persistPendingAck(msgId, pending);
        }

        return completed;
    }

    async clearPendingAck(msgId: string): Promise<boolean> {
        await this.ready();

        const deleted = this.pendingAckByMsgId.delete(msgId);
        if (deleted) {
            await this.persistence.removeItem(this.toPendingKey(msgId));
        }

        return deleted;
    }

    private async hydrate(): Promise<void> {
        for (const key of await this.persistence.getAllKeys()) {
            const stored = await this.persistence.getItem(key);
            if (!stored) {
                continue;
            }

            if (key.startsWith('acks:') && stored.kind === 'acks') {
                this.acksByMsgId.set(key.slice('acks:'.length), [...stored.values]);
            }

            if (key.startsWith('nacks:') && stored.kind === 'nacks') {
                this.nacksByMsgId.set(key.slice('nacks:'.length), [...stored.values]);
            }

            if (key.startsWith('repairs:') && stored.kind === 'repairs') {
                this.repairsByMsgId.set(key.slice('repairs:'.length), [...stored.values]);
            }

            if (key.startsWith('pending:') && stored.kind === 'pending') {
                this.pendingAckByMsgId.set(
                    key.slice('pending:'.length),
                    deserializePendingAckState(stored.value)
                );
            }
        }

        this.hydrated = true;
    }

    private assertReady(): void {
        if (!this.hydrated) {
            throw new Error('PersistentALControlTracker is not ready. Await ready() before use.');
        }
    }

    private async recordAck(payload: ALAckPayload): Promise<ALControlAcceptance> {
        this.push(this.acksByMsgId, payload.ackedMsgId, payload);
        await this.persistence.setItem(
            this.toAcksKey(payload.ackedMsgId),
            {
                kind: 'acks',
                values: this.acksByMsgId.get(payload.ackedMsgId) ?? []
            },
            {
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );

        const pending = this.pendingAckByMsgId.get(payload.ackedMsgId);
        if (!pending) {
            return {
                handled: true,
                completedPendingAcks: []
            };
        }

        if (
            pending.expectedFromPeerIds.size === 0 ||
            pending.expectedFromPeerIds.has(payload.fromPeerId)
        ) {
            pending.ackedFromPeerIds.add(payload.fromPeerId);
        }

        const completed = await this.tryCompletePendingAck(payload.ackedMsgId);
        if (!completed) {
            await this.persistPendingAck(payload.ackedMsgId, pending);
        }

        return {
            handled: true,
            completedPendingAcks: completed ? [completed] : []
        };
    }

    private async tryCompletePendingAck(msgId: string): Promise<ALCompletedPendingAck | undefined> {
        const pending = this.pendingAckByMsgId.get(msgId);
        if (!pending || !pending.localReady) {
            return undefined;
        }

        const isComplete = pending.expectedFromPeerIds.size === 0 ||
            [...pending.expectedFromPeerIds].every((peerId) => pending.ackedFromPeerIds.has(peerId));

        if (!isComplete) {
            return undefined;
        }

        this.pendingAckByMsgId.delete(msgId);
        await this.persistence.removeItem(this.toPendingKey(msgId));

        return {
            msgId,
            toPeerId: pending.toPeerId,
            status: pending.status
        };
    }

    private async recordNack(payload: ALNackPayload): Promise<void> {
        this.push(this.nacksByMsgId, payload.msgId, payload);
        await this.persistence.setItem(
            this.toNacksKey(payload.msgId),
            {
                kind: 'nacks',
                values: this.nacksByMsgId.get(payload.msgId) ?? []
            },
            {
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
    }

    private async recordRepair(payload: ALRepairPayload): Promise<void> {
        this.push(this.repairsByMsgId, payload.msgId, payload);
        await this.persistence.setItem(
            this.toRepairsKey(payload.msgId),
            {
                kind: 'repairs',
                values: this.repairsByMsgId.get(payload.msgId) ?? []
            },
            {
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
    }

    private async persistPendingAck(
        msgId: string,
        pending: ALPendingAckState
    ): Promise<void> {
        await this.persistence.setItem(
            this.toPendingKey(msgId),
            {
                kind: 'pending',
                value: serializePendingAckState(pending)
            },
            {
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
    }

    private push<T>(
        target: Map<string, T[]>,
        key: string,
        payload: T
    ): void {
        const values = target.get(key) ?? [];
        values.push(payload);
        target.set(key, values);
    }

    private toAcksKey(msgId: string): string {
        return `acks:${msgId}`;
    }

    private toNacksKey(msgId: string): string {
        return `nacks:${msgId}`;
    }

    private toRepairsKey(msgId: string): string {
        return `repairs:${msgId}`;
    }

    private toPendingKey(msgId: string): string {
        return `pending:${msgId}`;
    }
}

function serializePendingAckState(
    pending: ALPendingAckState
): PersistedALPendingAckState {
    return {
        toPeerId: pending.toPeerId,
        status: pending.status,
        localReady: pending.localReady,
        expectedFromPeerIds: [...pending.expectedFromPeerIds],
        ackedFromPeerIds: [...pending.ackedFromPeerIds]
    };
}

function deserializePendingAckState(
    pending: PersistedALPendingAckState
): ALPendingAckState {
    return {
        toPeerId: pending.toPeerId,
        status: pending.status,
        localReady: pending.localReady,
        expectedFromPeerIds: new Set<string>(pending.expectedFromPeerIds),
        ackedFromPeerIds: new Set<string>(pending.ackedFromPeerIds)
    };
}

function toControlRoute(
    senderId: string,
    toPeerId: string,
    msgId: string,
    controlTypeId: string
): ALRoute {
    return {
        topicId: 'al-control',
        resourceId: `${msgId}:${controlTypeId}`,
        contextId: `${senderId}:${toPeerId}`
    };
}
