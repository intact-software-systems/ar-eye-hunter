import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import type { ALMessage } from './al-contract.ts';

export interface ALReadyable {
    ready(): Promise<void>;
}

export interface ALDedupStoreLike {
    has(key: string, nowMs?: number): boolean;
}

export interface ALDedupStore extends ALDedupStoreLike, ALReadyable {
    mark(
        key: string,
        ttlMs: number,
        nowMs?: number,
    ): Promise<void>;

    deleteExpired(nowMs?: number): Promise<number>;
}

export class InMemoryALDedupStore implements ALDedupStore {
    private readonly expiresAtMsByKey = new Map<string, number>();

    async ready(): Promise<void> {
    }

    has(key: string, nowMs: number = Date.now()): boolean {
        const expiresAtMs = this.expiresAtMsByKey.get(key);
        if (expiresAtMs === undefined) {
            return false;
        }

        if (expiresAtMs <= nowMs) {
            this.expiresAtMsByKey.delete(key);
            return false;
        }

        return true;
    }

    async mark(
        key: string,
        ttlMs: number,
        nowMs: number = Date.now(),
    ): Promise<void> {
        this.expiresAtMsByKey.set(key, nowMs + Math.max(0, ttlMs));
    }

    async deleteExpired(nowMs: number = Date.now()): Promise<number> {
        let deleted = 0;

        for (const [key, expiresAtMs] of this.expiresAtMsByKey.entries()) {
            if (expiresAtMs <= nowMs) {
                this.expiresAtMsByKey.delete(key);
                deleted += 1;
            }
        }

        return deleted;
    }
}

export class PersistentALDedupStore implements ALDedupStore {
    private readonly expiresAtMsByKey = new Map<string, number>();
    private readonly readyPromise: Promise<void>;
    private hydrated = false;

    constructor(
        private readonly persistence: PersistenceProvider<string, number>,
    ) {
        this.readyPromise = this.hydrate();
    }

    async ready(): Promise<void> {
        await this.readyPromise;
    }

    has(key: string, nowMs: number = Date.now()): boolean {
        this.assertReady();

        const expiresAtMs = this.expiresAtMsByKey.get(key);
        if (expiresAtMs === undefined) {
            return false;
        }

        if (expiresAtMs <= nowMs) {
            this.expiresAtMsByKey.delete(key);
            void this.persistence.removeItem(key).catch(error => {
                logPersistenceError(`Failed to remove expired dedup key ${key}`, error);
            });
            return false;
        }

        return true;
    }

    async mark(
        key: string,
        ttlMs: number,
        nowMs: number = Date.now(),
    ): Promise<void> {
        await this.ready();

        const expiresAtMs = nowMs + Math.max(0, ttlMs);
        this.expiresAtMsByKey.set(key, expiresAtMs);
        await this.persistence.setItem(
            key,
            expiresAtMs,
            {
                expireAtTimestamp: expiresAtMs,
            },
        );
    }

    async deleteExpired(nowMs: number = Date.now()): Promise<number> {
        await this.ready();

        const keysToDelete: string[] = [];
        for (const [key, expiresAtMs] of this.expiresAtMsByKey.entries()) {
            if (expiresAtMs <= nowMs) {
                this.expiresAtMsByKey.delete(key);
                keysToDelete.push(key);
            }
        }

        await Promise.all(keysToDelete.map(async key => {
            await this.persistence.removeItem(key);
        }));

        return keysToDelete.length;
    }

    private async hydrate(): Promise<void> {
        const nowMs = Date.now();

        for (const key of await this.persistence.getAllKeys()) {
            const expiresAtMs = await this.persistence.getItem(key);
            if (expiresAtMs === undefined) {
                continue;
            }

            if (expiresAtMs <= nowMs) {
                await this.persistence.removeItem(key);
                continue;
            }

            this.expiresAtMsByKey.set(key, expiresAtMs);
        }

        this.hydrated = true;
    }

    private assertReady(): void {
        if (!this.hydrated) {
            throw new Error('PersistentALDedupStore is not ready. Await ready() before use.');
        }
    }
}

export type ALOrderingObservationStatus =
    | 'untracked'
    | 'in-order'
    | 'gap'
    | 'duplicate'
    | 'stale';

export type ALOrderingObservation = Readonly<{
    status: ALOrderingObservationStatus;
    trackKey?: string;
    seq?: number;
    expectedSeq?: number;
    lastContiguousSeq?: number;
    missingSeqs: readonly number[];
    releasableSeqs: readonly number[];
}>;

export interface ALOrderingStoreLike {
    peek(msg: ALMessage, nowMs?: number): ALOrderingObservation;
}

export interface ALOrderingStore extends ALOrderingStoreLike, ALReadyable {
    accept(
        msg: ALMessage,
        nowMs?: number,
    ): Promise<ALOrderingObservation>;

    deleteExpired(nowMs?: number): Promise<number>;
}

export type ALSupersedenceInput = Readonly<{
    key?: string;
    msgId: string;
    replacesMsgId?: string;
    seq?: number;
    ts: number;
}>;

export type ALSupersedenceObservationStatus =
    | 'untracked'
    | 'current'
    | 'superseded'
    | 'replaces-current';

export type ALSupersedenceObservation = Readonly<{
    status: ALSupersedenceObservationStatus;
    key?: string;
    latestMsgId?: string;
    replacesMsgId?: string;
}>;

export interface ALSupersedenceStoreLike {
    peek(input: ALSupersedenceInput, nowMs?: number): ALSupersedenceObservation;
}

export interface ALSupersedenceStore extends ALSupersedenceStoreLike, ALReadyable {
    accept(
        input: ALSupersedenceInput,
        nowMs?: number,
    ): Promise<ALSupersedenceObservation>;

    deleteExpired(nowMs?: number): Promise<number>;
}

type ALOrderingTrackState = {
    lastContiguousSeq: number;
    bufferedSeqs: Set<number>;
    updatedAtMs: number;
};

type PersistedALOrderingTrackState = Readonly<{
    lastContiguousSeq: number;
    bufferedSeqs: readonly number[];
    updatedAtMs: number;
}>;

export type ALOrderingTrackSnapshot = PersistedALOrderingTrackState;

type ALSupersedenceTrackState = {
    latestMsgId: string;
    latestSeq?: number;
    latestTs: number;
    updatedAtMs: number;
};

type ALSupersedenceReplacementState = {
    byMsgId: string;
    updatedAtMs: number;
};

type PersistedALSupersedenceValue =
    | Readonly<{
    kind: 'latest';
    latestMsgId: string;
    latestSeq?: number;
    latestTs: number;
    updatedAtMs: number;
}>
    | Readonly<{
    kind: 'replacement';
    byMsgId: string;
    updatedAtMs: number;
}>;

export type ALSupersedencePersistenceValue = PersistedALSupersedenceValue;

export class InMemoryALOrderingStore implements ALOrderingStore {
    private readonly stateByTrackKey = new Map<string, ALOrderingTrackState>();

    constructor(
        private readonly trackTtlMs: number = 5 * 60_000,
    ) {
    }

    async ready(): Promise<void> {
    }

    peek(msg: ALMessage, nowMs: number = Date.now()): ALOrderingObservation {
        this.deleteExpiredLocally(nowMs);
        return this.computeObservation(msg, nowMs, false);
    }

    async accept(msg: ALMessage, nowMs: number = Date.now()): Promise<ALOrderingObservation> {
        await this.deleteExpired(nowMs);
        return this.computeObservation(msg, nowMs, true);
    }

    async deleteExpired(nowMs: number = Date.now()): Promise<number> {
        return this.deleteExpiredLocally(nowMs);
    }

    static toTrackKey(msg: ALMessage): string | undefined {
        return toALOrderingTrackKey(msg);
    }

    private deleteExpiredLocally(nowMs: number): number {
        let deleted = 0;

        for (const [trackKey, state] of this.stateByTrackKey.entries()) {
            if (state.updatedAtMs + this.trackTtlMs <= nowMs) {
                this.stateByTrackKey.delete(trackKey);
                deleted += 1;
            }
        }

        return deleted;
    }

    private computeObservation(
        msg: ALMessage,
        nowMs: number,
        apply: boolean,
    ): ALOrderingObservation {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;

        if (trackKey === undefined || seq === undefined) {
            return {
                status: 'untracked',
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        const state = this.stateByTrackKey.get(trackKey);
        if (!state) {
            if (seq > 1) {
                const missingSeqs = Array.from({ length: seq - 1 }, (_, index) => index + 1);

                if (apply) {
                    this.stateByTrackKey.set(
                        trackKey,
                        {
                            lastContiguousSeq: 0,
                            bufferedSeqs: new Set<number>([seq]),
                            updatedAtMs: nowMs,
                        },
                    );
                }

                return {
                    status: 'gap',
                    trackKey,
                    seq,
                    expectedSeq: 1,
                    lastContiguousSeq: 0,
                    missingSeqs,
                    releasableSeqs: [],
                };
            }

            if (apply) {
                this.stateByTrackKey.set(
                    trackKey,
                    {
                        lastContiguousSeq: seq,
                        bufferedSeqs: new Set<number>(),
                        updatedAtMs: nowMs,
                    },
                );
            }

            return {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: seq,
                lastContiguousSeq: seq,
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        if (seq < state.lastContiguousSeq) {
            return {
                status: 'stale',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: state.lastContiguousSeq,
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        if (seq === state.lastContiguousSeq || state.bufferedSeqs.has(seq)) {
            return {
                status: 'duplicate',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: state.lastContiguousSeq,
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        if (seq === state.lastContiguousSeq + 1) {
            const releasableSeqs: number[] = [];

            if (apply) {
                state.lastContiguousSeq = seq;
                while (state.bufferedSeqs.has(state.lastContiguousSeq + 1)) {
                    state.lastContiguousSeq += 1;
                    state.bufferedSeqs.delete(state.lastContiguousSeq);
                    releasableSeqs.push(state.lastContiguousSeq);
                }
                state.updatedAtMs = nowMs;
            } else {
                let candidate = seq;
                while (state.bufferedSeqs.has(candidate + 1)) {
                    candidate += 1;
                    releasableSeqs.push(candidate);
                }
            }

            return {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: apply ? state.lastContiguousSeq : seq,
                missingSeqs: [],
                releasableSeqs,
            };
        }

        const expectedSeq = state.lastContiguousSeq + 1;
        const missingSeqs = [];

        for (let candidate = expectedSeq; candidate < seq; candidate += 1) {
            if (!state.bufferedSeqs.has(candidate)) {
                missingSeqs.push(candidate);
            }
        }

        if (apply) {
            state.bufferedSeqs.add(seq);
            state.updatedAtMs = nowMs;
        }

        return {
            status: 'gap',
            trackKey,
            seq,
            expectedSeq,
            lastContiguousSeq: state.lastContiguousSeq,
            missingSeqs,
            releasableSeqs: [],
        };
    }
}

export class PersistentALOrderingStore implements ALOrderingStore {
    private readonly stateByTrackKey = new Map<string, ALOrderingTrackState>();
    private readonly readyPromise: Promise<void>;
    private hydrated = false;

    constructor(
        private readonly persistence: PersistenceProvider<string, PersistedALOrderingTrackState>,
        private readonly trackTtlMs: number = 5 * 60_000,
    ) {
        this.readyPromise = this.hydrate();
    }

    async ready(): Promise<void> {
        await this.readyPromise;
    }

    peek(msg: ALMessage, nowMs: number = Date.now()): ALOrderingObservation {
        this.assertReady();
        this.deleteExpiredLocally(nowMs);
        return this.computeObservation(msg, nowMs, false);
    }

    async accept(msg: ALMessage, nowMs: number = Date.now()): Promise<ALOrderingObservation> {
        await this.deleteExpired(nowMs);

        const observation = this.computeObservation(msg, nowMs, true);
        if (observation.trackKey && shouldPersistOrderingObservation(observation.status)) {
            const state = this.stateByTrackKey.get(observation.trackKey);
            if (state) {
                await this.persistence.setItem(
                    observation.trackKey,
                    serializeOrderingTrackState(state),
                    {
                        expireAtTimestamp: state.updatedAtMs + this.trackTtlMs,
                    },
                );
            }
        }

        return observation;
    }

    async deleteExpired(nowMs: number = Date.now()): Promise<number> {
        await this.ready();

        const keysToDelete = this.deleteExpiredLocally(nowMs);
        await Promise.all(keysToDelete.map(async trackKey => {
            await this.persistence.removeItem(trackKey);
        }));
        return keysToDelete.length;
    }

    static toTrackKey(msg: ALMessage): string | undefined {
        return toALOrderingTrackKey(msg);
    }

    private async hydrate(): Promise<void> {
        const nowMs = Date.now();

        for (const trackKey of await this.persistence.getAllKeys()) {
            const stored = await this.persistence.getItem(trackKey);
            if (!stored) {
                continue;
            }

            if (stored.updatedAtMs + this.trackTtlMs <= nowMs) {
                await this.persistence.removeItem(trackKey);
                continue;
            }

            this.stateByTrackKey.set(trackKey, deserializeOrderingTrackState(stored));
        }

        this.hydrated = true;
    }

    private assertReady(): void {
        if (!this.hydrated) {
            throw new Error('PersistentALOrderingStore is not ready. Await ready() before use.');
        }
    }

    private deleteExpiredLocally(nowMs: number): string[] {
        const deletedTrackKeys: string[] = [];

        for (const [trackKey, state] of this.stateByTrackKey.entries()) {
            if (state.updatedAtMs + this.trackTtlMs <= nowMs) {
                this.stateByTrackKey.delete(trackKey);
                deletedTrackKeys.push(trackKey);
            }
        }

        return deletedTrackKeys;
    }

    private computeObservation(
        msg: ALMessage,
        nowMs: number,
        apply: boolean,
    ): ALOrderingObservation {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;

        if (trackKey === undefined || seq === undefined) {
            return {
                status: 'untracked',
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        const state = this.stateByTrackKey.get(trackKey);
        if (!state) {
            if (seq > 1) {
                const missingSeqs = Array.from({ length: seq - 1 }, (_, index) => index + 1);

                if (apply) {
                    this.stateByTrackKey.set(
                        trackKey,
                        {
                            lastContiguousSeq: 0,
                            bufferedSeqs: new Set<number>([seq]),
                            updatedAtMs: nowMs,
                        },
                    );
                }

                return {
                    status: 'gap',
                    trackKey,
                    seq,
                    expectedSeq: 1,
                    lastContiguousSeq: 0,
                    missingSeqs,
                    releasableSeqs: [],
                };
            }

            if (apply) {
                this.stateByTrackKey.set(
                    trackKey,
                    {
                        lastContiguousSeq: seq,
                        bufferedSeqs: new Set<number>(),
                        updatedAtMs: nowMs,
                    },
                );
            }

            return {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: seq,
                lastContiguousSeq: seq,
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        if (seq < state.lastContiguousSeq) {
            return {
                status: 'stale',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: state.lastContiguousSeq,
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        if (seq === state.lastContiguousSeq || state.bufferedSeqs.has(seq)) {
            return {
                status: 'duplicate',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: state.lastContiguousSeq,
                missingSeqs: [],
                releasableSeqs: [],
            };
        }

        if (seq === state.lastContiguousSeq + 1) {
            const releasableSeqs: number[] = [];

            if (apply) {
                state.lastContiguousSeq = seq;
                while (state.bufferedSeqs.has(state.lastContiguousSeq + 1)) {
                    state.lastContiguousSeq += 1;
                    state.bufferedSeqs.delete(state.lastContiguousSeq);
                    releasableSeqs.push(state.lastContiguousSeq);
                }
                state.updatedAtMs = nowMs;
            } else {
                let candidate = seq;
                while (state.bufferedSeqs.has(candidate + 1)) {
                    candidate += 1;
                    releasableSeqs.push(candidate);
                }
            }

            return {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: apply ? state.lastContiguousSeq : seq,
                missingSeqs: [],
                releasableSeqs,
            };
        }

        const expectedSeq = state.lastContiguousSeq + 1;
        const missingSeqs = [];

        for (let candidate = expectedSeq; candidate < seq; candidate += 1) {
            if (!state.bufferedSeqs.has(candidate)) {
                missingSeqs.push(candidate);
            }
        }

        if (apply) {
            state.bufferedSeqs.add(seq);
            state.updatedAtMs = nowMs;
        }

        return {
            status: 'gap',
            trackKey,
            seq,
            expectedSeq,
            lastContiguousSeq: state.lastContiguousSeq,
            missingSeqs,
            releasableSeqs: [],
        };
    }
}

export class InMemoryALSupersedenceStore implements ALSupersedenceStore {
    private readonly latestByKey = new Map<string, ALSupersedenceTrackState>();
    private readonly replacementByMsgId = new Map<string, ALSupersedenceReplacementState>();

    constructor(
        private readonly trackTtlMs: number = 5 * 60_000,
    ) {
    }

    async ready(): Promise<void> {
    }

    peek(
        input: ALSupersedenceInput,
        nowMs: number = Date.now(),
    ): ALSupersedenceObservation {
        this.deleteExpiredLocally(nowMs);

        if (!input.key) {
            return {
                status: 'untracked',
            };
        }

        const replacement = this.replacementByMsgId.get(input.msgId);
        if (replacement) {
            return {
                status: 'superseded',
                key: input.key,
                latestMsgId: replacement.byMsgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        const current = this.latestByKey.get(input.key);
        if (!current) {
            return {
                status: 'current',
                key: input.key,
                latestMsgId: input.msgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        if (current.latestMsgId === input.msgId) {
            return {
                status: 'current',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        if (input.replacesMsgId && current.latestMsgId === input.replacesMsgId) {
            return {
                status: 'replaces-current',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        const comparison = compareSupersedenceVersion(
            input.seq,
            input.ts,
            current.latestSeq,
            current.latestTs,
        );

        return comparison >= 0
            ? {
                status: 'replaces-current',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            }
            : {
                status: 'superseded',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            };
    }

    async accept(
        input: ALSupersedenceInput,
        nowMs: number = Date.now(),
    ): Promise<ALSupersedenceObservation> {
        await this.deleteExpired(nowMs);

        const observation = this.peek(input, nowMs);
        if (!input.key || observation.status === 'superseded') {
            return observation;
        }

        const current = this.latestByKey.get(input.key);
        const latestMsgId = current?.latestMsgId;

        this.latestByKey.set(
            input.key,
            {
                latestMsgId: input.msgId,
                latestSeq: input.seq,
                latestTs: input.ts,
                updatedAtMs: nowMs,
            },
        );

        if (latestMsgId && latestMsgId !== input.msgId) {
            this.replacementByMsgId.set(
                latestMsgId,
                {
                    byMsgId: input.msgId,
                    updatedAtMs: nowMs,
                },
            );
        }

        if (input.replacesMsgId && input.replacesMsgId !== input.msgId) {
            this.replacementByMsgId.set(
                input.replacesMsgId,
                {
                    byMsgId: input.msgId,
                    updatedAtMs: nowMs,
                },
            );
        }

        return {
            status: 'current',
            key: input.key,
            latestMsgId: input.msgId,
            replacesMsgId: input.replacesMsgId,
        };
    }

    async deleteExpired(nowMs: number = Date.now()): Promise<number> {
        return this.deleteExpiredLocally(nowMs);
    }

    private deleteExpiredLocally(nowMs: number): number {
        let deleted = 0;

        for (const [key, state] of this.latestByKey.entries()) {
            if (state.updatedAtMs + this.trackTtlMs <= nowMs) {
                this.latestByKey.delete(key);
                deleted += 1;
            }
        }

        for (const [msgId, state] of this.replacementByMsgId.entries()) {
            if (state.updatedAtMs + this.trackTtlMs <= nowMs) {
                this.replacementByMsgId.delete(msgId);
                deleted += 1;
            }
        }

        return deleted;
    }
}

export class PersistentALSupersedenceStore implements ALSupersedenceStore {
    private readonly latestByKey = new Map<string, ALSupersedenceTrackState>();
    private readonly replacementByMsgId = new Map<string, ALSupersedenceReplacementState>();
    private readonly readyPromise: Promise<void>;
    private hydrated = false;

    constructor(
        private readonly persistence: PersistenceProvider<string, PersistedALSupersedenceValue>,
        private readonly trackTtlMs: number = 5 * 60_000,
    ) {
        this.readyPromise = this.hydrate();
    }

    async ready(): Promise<void> {
        await this.readyPromise;
    }

    peek(
        input: ALSupersedenceInput,
        nowMs: number = Date.now(),
    ): ALSupersedenceObservation {
        this.assertReady();
        this.deleteExpiredLocally(nowMs);

        if (!input.key) {
            return {
                status: 'untracked',
            };
        }

        const replacement = this.replacementByMsgId.get(input.msgId);
        if (replacement) {
            return {
                status: 'superseded',
                key: input.key,
                latestMsgId: replacement.byMsgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        const current = this.latestByKey.get(input.key);
        if (!current) {
            return {
                status: 'current',
                key: input.key,
                latestMsgId: input.msgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        if (current.latestMsgId === input.msgId) {
            return {
                status: 'current',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        if (input.replacesMsgId && current.latestMsgId === input.replacesMsgId) {
            return {
                status: 'replaces-current',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            };
        }

        const comparison = compareSupersedenceVersion(
            input.seq,
            input.ts,
            current.latestSeq,
            current.latestTs,
        );

        return comparison >= 0
            ? {
                status: 'replaces-current',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            }
            : {
                status: 'superseded',
                key: input.key,
                latestMsgId: current.latestMsgId,
                replacesMsgId: input.replacesMsgId,
            };
    }

    async accept(
        input: ALSupersedenceInput,
        nowMs: number = Date.now(),
    ): Promise<ALSupersedenceObservation> {
        await this.deleteExpired(nowMs);

        const observation = this.peek(input, nowMs);
        if (!input.key || observation.status === 'superseded') {
            return observation;
        }

        const current = this.latestByKey.get(input.key);
        const previousLatestMsgId = current?.latestMsgId;

        this.latestByKey.set(
            input.key,
            {
                latestMsgId: input.msgId,
                latestSeq: input.seq,
                latestTs: input.ts,
                updatedAtMs: nowMs,
            },
        );
        await this.persistence.setItem(
            this.toLatestPersistenceKey(input.key),
            {
                kind: 'latest',
                latestMsgId: input.msgId,
                latestSeq: input.seq,
                latestTs: input.ts,
                updatedAtMs: nowMs,
            },
            {
                expireAtTimestamp: nowMs + this.trackTtlMs,
            },
        );

        if (previousLatestMsgId && previousLatestMsgId !== input.msgId) {
            this.replacementByMsgId.set(
                previousLatestMsgId,
                {
                    byMsgId: input.msgId,
                    updatedAtMs: nowMs,
                },
            );
            await this.persistence.setItem(
                this.toReplacementPersistenceKey(previousLatestMsgId),
                {
                    kind: 'replacement',
                    byMsgId: input.msgId,
                    updatedAtMs: nowMs,
                },
                {
                    expireAtTimestamp: nowMs + this.trackTtlMs,
                },
            );
        }

        if (input.replacesMsgId && input.replacesMsgId !== input.msgId) {
            this.replacementByMsgId.set(
                input.replacesMsgId,
                {
                    byMsgId: input.msgId,
                    updatedAtMs: nowMs,
                },
            );
            await this.persistence.setItem(
                this.toReplacementPersistenceKey(input.replacesMsgId),
                {
                    kind: 'replacement',
                    byMsgId: input.msgId,
                    updatedAtMs: nowMs,
                },
                {
                    expireAtTimestamp: nowMs + this.trackTtlMs,
                },
            );
        }

        return {
            status: 'current',
            key: input.key,
            latestMsgId: input.msgId,
            replacesMsgId: input.replacesMsgId,
        };
    }

    async deleteExpired(nowMs: number = Date.now()): Promise<number> {
        await this.ready();

        const keysToDelete = this.deleteExpiredLocally(nowMs);
        await Promise.all(keysToDelete.map(async key => {
            await this.persistence.removeItem(key);
        }));
        return keysToDelete.length;
    }

    private async hydrate(): Promise<void> {
        const nowMs = Date.now();

        for (const key of await this.persistence.getAllKeys()) {
            const stored = await this.persistence.getItem(key);
            if (!stored) {
                continue;
            }

            if (stored.updatedAtMs + this.trackTtlMs <= nowMs) {
                await this.persistence.removeItem(key);
                continue;
            }

            if (key.startsWith('latest:') && stored.kind === 'latest') {
                this.latestByKey.set(
                    key.slice('latest:'.length),
                    {
                        latestMsgId: stored.latestMsgId,
                        latestSeq: stored.latestSeq,
                        latestTs: stored.latestTs,
                        updatedAtMs: stored.updatedAtMs,
                    },
                );
            }

            if (key.startsWith('replacement:') && stored.kind === 'replacement') {
                this.replacementByMsgId.set(
                    key.slice('replacement:'.length),
                    {
                        byMsgId: stored.byMsgId,
                        updatedAtMs: stored.updatedAtMs,
                    },
                );
            }
        }

        this.hydrated = true;
    }

    private assertReady(): void {
        if (!this.hydrated) {
            throw new Error('PersistentALSupersedenceStore is not ready. Await ready() before use.');
        }
    }

    private deleteExpiredLocally(nowMs: number): string[] {
        const keysToDelete: string[] = [];

        for (const [key, state] of this.latestByKey.entries()) {
            if (state.updatedAtMs + this.trackTtlMs <= nowMs) {
                this.latestByKey.delete(key);
                keysToDelete.push(this.toLatestPersistenceKey(key));
            }
        }

        for (const [msgId, state] of this.replacementByMsgId.entries()) {
            if (state.updatedAtMs + this.trackTtlMs <= nowMs) {
                this.replacementByMsgId.delete(msgId);
                keysToDelete.push(this.toReplacementPersistenceKey(msgId));
            }
        }

        return keysToDelete;
    }

    private toLatestPersistenceKey(key: string): string {
        return `latest:${key}`;
    }

    private toReplacementPersistenceKey(msgId: string): string {
        return `replacement:${msgId}`;
    }
}

export function toALOrderingTrackKey(msg: ALMessage): string | undefined {
    const orderingKey = msg.ordering?.orderingKey;
    const seq = msg.ordering?.seq;

    if (orderingKey === undefined || seq === undefined) {
        return undefined;
    }

    return `${orderingKey}:${msg.id.senderId}:${msg.ordering?.epoch ?? 0}`;
}

function shouldPersistOrderingObservation(status: ALOrderingObservationStatus): boolean {
    return status === 'in-order' || status === 'gap';
}

function serializeOrderingTrackState(
    state: ALOrderingTrackState,
): PersistedALOrderingTrackState {
    return {
        lastContiguousSeq: state.lastContiguousSeq,
        bufferedSeqs: [...state.bufferedSeqs].sort((left, right) => left - right),
        updatedAtMs: state.updatedAtMs,
    };
}

function deserializeOrderingTrackState(
    state: PersistedALOrderingTrackState,
): ALOrderingTrackState {
    return {
        lastContiguousSeq: state.lastContiguousSeq,
        bufferedSeqs: new Set<number>(state.bufferedSeqs),
        updatedAtMs: state.updatedAtMs,
    };
}

function compareSupersedenceVersion(
    leftSeq: number | undefined,
    leftTs: number,
    rightSeq: number | undefined,
    rightTs: number,
): number {
    if (leftSeq !== undefined || rightSeq !== undefined) {
        const seqComparison = (leftSeq ?? Number.NEGATIVE_INFINITY) - (rightSeq ?? Number.NEGATIVE_INFINITY);
        if (seqComparison !== 0) {
            return Math.sign(seqComparison);
        }
    }

    return Math.sign(leftTs - rightTs);
}

function logPersistenceError(message: string, error: unknown): void {
    console.error(message, error);
}
