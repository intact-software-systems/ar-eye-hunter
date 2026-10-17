import { NEVER_EXPIRE_AT_TIMESTAMP } from '../../persistence/PersistenceProvider.ts';
import type { InMemoryQueueBox } from '../../queuebox/in-memory-queue-box.ts';
import { toResourceEntrySnapshot } from '../../queuebox/resource-entry-observations.ts';
import {
    toKeyAsString,
    toResourceEntryKey,
    type Key,
    type ResourceEntry
} from '../../queuebox/ResourceEntry.ts';

import type {
    ALAdmissionBackend,
    ALAdmissionBackendEntry,
    ALAdmissionStoredValue,
    ALAdmissionWriteContext
} from '../al-admission-backend.ts';
import { decodeALAdmissionValue, type ALAdmissionDecoder } from '../al-admission-decoder.ts';
import { decodeALAdmissionNumber } from '../al-admission-value-validation.ts';
import type { ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';

class ALAdmissionWriteBuffer implements ALAdmissionWriteContext {
    private readonly pending = new Map<string, ALAdmissionStoredValue | undefined>();
    private readonly markedTerminalVolatileRows = new Set<ALAdmissionStoredValue>();
    private readonly storage: Pick<ALAdmissionBackend, 'read' | 'list'>;
    private readonly nowMs: () => number;

    constructor(storage: Pick<ALAdmissionBackend, 'read' | 'list'>, nowMs: () => number) {
        this.storage = storage;
        this.nowMs = nowMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        if (!this.pending.has(key)) {
            return await this.storage.read(key, decode);
        }
        const stored = this.pending.get(key);
        if (!stored) {
            return undefined;
        }
        const value = decodeALAdmissionValue(stored.value, key, decode);
        return stored.expireAtTimestamp <= this.nowMs() ? undefined : value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const values = new Map<string, V>();
        const entries = await this.storage.list(prefix, (value, key) =>
            this.pending.has(key)
                ? { kind: 'shadowed' as const }
                : { kind: 'decoded' as const, value: decodeALAdmissionValue(value, key, decode) });
        for (const entry of entries) {
            if (entry.value.kind === 'decoded') {
                values.set(entry.key, entry.value.value);
            }
        }
        for (const [key, stored] of this.pending) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            if (!stored) {
                values.delete(key);
                continue;
            }
            const value = decodeALAdmissionValue(stored.value, key, decode);
            if (stored.expireAtTimestamp <= this.nowMs()) {
                values.delete(key);
                continue;
            }
            values.set(key, value);
        }
        return [...values].map(([key, value]) => ({ key, value }));
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        this.pending.set(key, { key, value, expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp) });
    }

    async remove(key: string): Promise<void> {
        this.pending.set(key, undefined);
    }

    mutations(): readonly (readonly [key: string, stored: ALAdmissionStoredValue | undefined])[] {
        return [...this.pending];
    }

    markTerminalVolatileRow(key: string): void {
        const row = this.pending.get(key);
        if (row === undefined) {
            throw new TypeError('Terminal volatile eligibility requires a provenance write in the same transaction');
        }
        this.markedTerminalVolatileRows.add(row);
    }

    terminalVolatileRows(): readonly ALAdmissionStoredValue[] {
        return [...this.markedTerminalVolatileRows].filter((row) => this.pending.get(row.key) === row);
    }
}

/** Only a memory transaction can retain volatile proof; persisted transactions fail closed. */
export function markTerminalVolatileAdmissionRow(transaction: ALAdmissionWriteContext, key: string): void {
    if (!(transaction instanceof ALAdmissionWriteBuffer)) {
        throw new TypeError('Terminal volatile eligibility requires an in-memory admission transaction');
    }
    transaction.markTerminalVolatileRow(key);
}

export class InMemoryAdmissionWorkWriteBuffer extends ALAdmissionWriteBuffer implements ALAdmissionWorkWriteContext {
    private readonly workQueue: InMemoryQueueBox;
    private readonly observations = new Map<string, ResourceEntry | undefined>();
    private readonly pendingWork = new Map<string, ResourceEntry>();

    constructor(storage: ALAdmissionBackend, nowMs: () => number, workQueue: InMemoryQueueBox) {
        super(storage, nowMs);
        this.workQueue = workQueue;
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const pending = this.pendingWork.get(keyString);
        if (pending !== undefined) {
            return toResourceEntrySnapshot(pending);
        }
        if (!this.observations.has(keyString)) {
            this.observations.set(keyString, await this.workQueue.getItem(key));
        }
        const observed = this.observations.get(keyString);
        return observed === undefined ? undefined : toResourceEntrySnapshot(observed);
    }

    async readClaimedWork(claimed: ResourceEntry): Promise<ResourceEntry | undefined> {
        return await this.readWork(claimed.key);
    }

    writeWork(entry: ResourceEntry): void {
        const key = toKeyAsString(entry.key);
        if (!this.observations.has(key) || this.pendingWork.has(key)) {
            throw new TypeError('Admission work requires one write after its slot has been read');
        }
        this.pendingWork.set(key, toResourceEntrySnapshot(entry));
    }

    queueWrites(): readonly InMemoryQueueBox.ComputedOperation[] {
        return [...this.observations].map(([key, expected]) => {
            const entry = this.pendingWork.get(key);
            return entry === undefined ? { key: toResourceEntryKey(key), expected } : { entry, expected };
        });
    }
}
