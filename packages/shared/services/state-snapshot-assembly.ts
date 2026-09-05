import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageRejection } from '../al-contracts/al-message-persistence-validation.ts';
import {
    decodeStateSnapshotPage,
    rejectSnapshotPage,
    STATE_SNAPSHOT_LIMITS,
    type CompletedStateSnapshot,
    type StateSnapshotPage
} from '../api/state-snapshot-page.ts';
import type { StateScope } from '../api/state-types.ts';
import { fnv1a64 } from '../queuebox/AppQueueIdentity.ts';
import { Either } from '../resilience/Either.ts';

interface PartialStateSnapshot {
    readonly page: StateSnapshotPage;
    readonly envelope: ALMessage;
    readonly chunks: ReadonlyMap<number, string>;
    readonly bytes: number;
    readonly deadlineMs: number;
}

interface CompletedTransferCommitment {
    readonly identity: string;
    readonly chunkChecksums: ReadonlyMap<number, string>;
}

interface SnapshotTransfer {
    readonly completed: CompletedTransferCommitment | undefined;
    readonly partial: PartialStateSnapshot | undefined;
    readonly status: 'pending' | 'complete' | 'cancelled';
    readonly timeout: ReturnType<typeof setTimeout> | undefined;
}

export type StateSnapshotAssemblyResult =
    | { readonly kind: 'pending' | 'duplicate'; }
    | { readonly kind: 'complete'; readonly snapshot: CompletedStateSnapshot; };

export namespace StateSnapshotAssembly {
    export interface Input {
        readonly message: ALMessage;
        readonly scope: StateScope;
        readonly nowMs: number;
    }
}

/** Owns bounded fragments for one trusted server connection lifecycle; never publishes partial state. */
export class StateSnapshotAssembly {
    readonly #transfers = new Map<string, SnapshotTransfer>();
    #disposed = false;

    accept(input: StateSnapshotAssembly.Input): Either<ALMessageRejection, StateSnapshotAssemblyResult> {
        if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
            return rejectSnapshotPage('malformed', 'Snapshot observation time is invalid');
        }
        if (this.#disposed) {
            return rejectSnapshotPage('malformed', 'Snapshot assembly is disposed');
        }
        const decoded = decodeStateSnapshotPage(input.message, input.scope);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const page = decoded.right!;
        const prior = this.#transfers.get(page.transferId);
        if (prior?.status === 'cancelled') {
            return rejectSnapshotPage('malformed', 'Snapshot transfer was cancelled');
        }
        if (page.expiresAtMs <= input.nowMs) {
            this.#settle(page.transferId, 'cancelled');
            return rejectSnapshotPage('malformed', 'Snapshot transfer expired');
        }
        if (prior?.status === 'complete') {
            if (
                prior.completed?.identity === snapshotTransferIdentity(page) &&
                prior.completed.chunkChecksums.get(page.index) === fnv1a64(page.chunk)
            ) {
                return Either.ofRight({ kind: 'duplicate' });
            }
            this.#settle(page.transferId, 'cancelled');
            return rejectSnapshotPage('malformed', 'Snapshot fragment conflicts with a completed transfer');
        }
        const computed = computeSnapshotFragment({
            page,
            envelope: input.message,
            prior: prior?.partial,
            nowMs: input.nowMs
        });
        if (computed.left) {
            this.#settle(page.transferId, 'cancelled');
            return Either.ofLeft(computed.left);
        }
        const partial = computed.right!;
        if (!this.#hasCapacity(page.transferId, partial)) {
            return rejectSnapshotPage('oversized', 'Snapshot assembly capacity is exhausted');
        }
        if (partial.chunks.size === page.count) {
            return this.#complete(page.transferId, partial);
        }
        const timeout = prior?.timeout ??
            setTimeout(() => this.#settle(page.transferId, 'cancelled'), partial.deadlineMs - input.nowMs);
        this.#transfers.set(page.transferId, { status: 'pending', partial, timeout, completed: undefined });
        return Either.ofRight({ kind: 'pending' });
    }

    clear(): void {
        for (const transfer of this.#transfers.values()) {
            clearTimeout(transfer.timeout);
        }
        this.#transfers.clear();
    }

    dispose(): void {
        this.clear();
        this.#disposed = true;
    }

    #hasCapacity(key: string, candidate: PartialStateSnapshot): boolean {
        for (const [transferId, transfer] of this.#transfers) {
            if (this.#transfers.size < STATE_SNAPSHOT_LIMITS.transfers) {
                break;
            }
            if (transferId !== key && transfer.status !== 'pending') {
                this.#transfers.delete(transferId);
            }
        }
        if (!this.#transfers.has(key) && this.#transfers.size >= STATE_SNAPSHOT_LIMITS.transfers) {
            return false;
        }
        let bytes = candidate.page.totalBytes;
        for (const [transferId, transfer] of this.#transfers) {
            if (transferId !== key) {
                bytes += transfer.partial?.page.totalBytes ?? 0;
            }
        }
        return bytes <= STATE_SNAPSHOT_LIMITS.aggregateBytes;
    }

    #complete(key: string, partial: PartialStateSnapshot): Either<ALMessageRejection, StateSnapshotAssemblyResult> {
        const resource = Array.from({ length: partial.page.count }, (_, index) => partial.chunks.get(index)!).join('');
        if (
            new TextEncoder().encode(resource).length !== partial.page.totalBytes ||
            fnv1a64(resource) !== partial.page.checksum
        ) {
            this.#settle(key, 'cancelled');
            return rejectSnapshotPage('malformed', 'Complete snapshot differs from its transfer commitment');
        }
        this.#settle(key, 'complete', {
            identity: snapshotTransferIdentity(partial.page),
            chunkChecksums: new Map([...partial.chunks].map(([index, chunk]) => [index, fnv1a64(chunk)]))
        });
        return Either.ofRight({
            kind: 'complete',
            snapshot: { page: partial.page, envelope: partial.envelope, resource }
        });
    }

    #settle(key: string, status: 'complete' | 'cancelled', completed?: CompletedTransferCommitment): void {
        const prior = this.#transfers.get(key);
        clearTimeout(prior?.timeout);
        if (prior || this.#transfers.size < STATE_SNAPSHOT_LIMITS.transfers) {
            this.#transfers.set(key, { status, partial: undefined, timeout: undefined, completed });
        }
    }
}

interface SnapshotFragmentInput {
    readonly page: StateSnapshotPage;
    readonly envelope: ALMessage;
    readonly prior: PartialStateSnapshot | undefined;
    readonly nowMs: number;
}

function computeSnapshotFragment(input: SnapshotFragmentInput): Either<ALMessageRejection, PartialStateSnapshot> {
    const { page, prior, nowMs } = input;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || (prior && nowMs >= prior.deadlineMs)) {
        return rejectSnapshotPage('malformed', 'Snapshot assembly deadline expired');
    }
    if (prior && snapshotTransferIdentity(prior.page) !== snapshotTransferIdentity(page)) {
        return rejectSnapshotPage('malformed', 'Snapshot fragment metadata conflicts');
    }
    const previous = prior?.chunks.get(page.index);
    if (previous !== undefined && previous !== page.chunk) {
        return rejectSnapshotPage('malformed', 'Snapshot fragment conflicts with an admitted page');
    }
    const chunks = new Map(prior?.chunks);
    chunks.set(page.index, page.chunk);
    const bytes = (prior?.bytes ?? 0) + (previous === undefined ? new TextEncoder().encode(page.chunk).length : 0);
    if (bytes > page.totalBytes) {
        return rejectSnapshotPage('oversized', 'Snapshot fragments exceed declared bytes');
    }
    return Either.ofRight({
        page,
        chunks,
        bytes,
        envelope: prior?.envelope ?? input.envelope,
        deadlineMs: prior?.deadlineMs ?? Math.min(page.expiresAtMs, nowMs + STATE_SNAPSHOT_LIMITS.assemblyMs)
    });
}

function snapshotTransferIdentity(page: StateSnapshotPage): string {
    return JSON.stringify([page.transferId, page.count, page.totalBytes, page.expiresAtMs, page.topicId, page.typeId]);
}
