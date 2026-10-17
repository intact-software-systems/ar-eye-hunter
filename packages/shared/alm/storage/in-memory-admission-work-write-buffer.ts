import { KeyedWriteSet } from '../../persistence/keyed-write-set.ts';
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

export class InMemoryAdmissionWorkWriteBuffer implements ALAdmissionWorkWriteContext {
    private readonly pending = new KeyedWriteSet<string, ALAdmissionStoredValue>();
    private readonly markedTerminalVolatileRows = new Set<ALAdmissionStoredValue>();
    private readonly storage: Pick<ALAdmissionBackend, 'read' | 'list'>;
    private readonly nowMs: () => number;
    private readonly workQueue: InMemoryQueueBox;
    private readonly observations = new Map<string, ResourceEntry | undefined>();
    private readonly pendingWork = new Map<string, ResourceEntry>();

    constructor(storage: ALAdmissionBackend, nowMs: () => number, workQueue: InMemoryQueueBox) {
        this.storage = storage;
        this.nowMs = nowMs;
        this.workQueue = workQueue;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const pending = this.pending.lookup(key);
        if (pending.kind === 'untouched') {
            return await this.storage.read(key, decode);
        }
        if (pending.kind === 'removed') {
            return undefined;
        }
        const stored = pending.value;
        const value = decodeALAdmissionValue(stored.value, key, decode);
        return stored.expireAtTimestamp <= this.nowMs() ? undefined : value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const entries = await this.storage.list(prefix, (value, key) =>
            this.pending.lookup(key).kind === 'untouched'
                ? { kind: 'decoded' as const, value: decodeALAdmissionValue(value, key, decode) }
                : { kind: 'shadowed' as const });
        const values: ALAdmissionBackendEntry<V>[] = [];
        for (const entry of this.pending.overlay(entries)) {
            if (entry.kind === 'stored') {
                if (entry.value.kind === 'decoded') {
                    values.push({ key: entry.key, value: entry.value.value });
                }
                continue;
            }
            if (!entry.key.startsWith(prefix)) {
                continue;
            }
            const stored = entry.value;
            const value = decodeALAdmissionValue(stored.value, entry.key, decode);
            if (stored.expireAtTimestamp > this.nowMs()) {
                values.push({ key: entry.key, value });
            }
        }
        return values;
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        this.pending.set(key, { key, value, expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp) });
    }

    async remove(key: string): Promise<void> {
        this.pending.remove(key);
    }

    mutations(): readonly (readonly [key: string, stored: ALAdmissionStoredValue | undefined])[] {
        return this.pending.mutations().map(([key, mutation]) => {
            const stored = mutation.kind === 'value' ? mutation.value : undefined;
            return [key, stored];
        });
    }

    markTerminalVolatileRow(key: string): void {
        const pending = this.pending.lookup(key);
        if (pending.kind !== 'value') {
            throw new TypeError('Terminal volatile eligibility requires a provenance write in the same transaction');
        }
        this.markedTerminalVolatileRows.add(pending.value);
    }

    terminalVolatileRows(): readonly ALAdmissionStoredValue[] {
        return [...this.markedTerminalVolatileRows].filter((row) => {
            const pending = this.pending.lookup(row.key);
            return pending.kind === 'value' && pending.value === row;
        });
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

/** Only a memory transaction can retain volatile proof; persisted transactions fail closed. */
export function markTerminalVolatileAdmissionRow(transaction: ALAdmissionWriteContext, key: string): void {
    if (!(transaction instanceof InMemoryAdmissionWorkWriteBuffer)) {
        throw new TypeError('Terminal volatile eligibility requires an in-memory admission transaction');
    }
    transaction.markTerminalVolatileRow(key);
}
