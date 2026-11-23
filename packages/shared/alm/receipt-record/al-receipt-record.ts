import { AL_RECEIPT_DEADLINE_GRACE_MS } from '../../al-contracts/al-control.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALAdmissionReadContext } from '../al-admission-backend.ts';
import type { ALAdmissionDecoder } from '../al-admission-decoder.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import { computeALReceiptRetentionExpiryMs } from '../delivery/compute-al-receipt-retention-expiry-ms.ts';

import {
    toALReceiptRecordConfirmationKey,
    toALReceiptRecordConfirmationPrefix,
    toALReceiptRecordHeadKey,
    type ALReceiptRecordRef
} from './al-receipt-record-keys.ts';
import {
    decodeALReceiptRecordConfirmation,
    decodeALReceiptRecordHead,
    type ALReceiptRecordConfirmation,
    type ALReceiptRecordEndedHead,
    type ALReceiptRecordHead,
    type ALReceiptRecordOpening
} from './al-receipt-record-rows.ts';
import { computeALReceiptRecordWorkEntry, type ALReceiptRecordWorkKind } from './al-receipt-record-work-entry.ts';
import { computeALReceiptRecordEnding } from './compute-al-receipt-record-ending.ts';
import { computeALReceiptRecordTally, type ALReceiptRecordTally } from './compute-al-receipt-record-tally.ts';
import {
    validateALReceiptRecordConfirmation,
    type ALReceiptRecordConfirmationDto,
    type ALReceiptRecordConfirmationIssue
} from './validate-al-receipt-record-confirmation.ts';
import {
    AL_RECEIPT_RECORD_WINDOW_MS,
    validateALReceiptRecordOpening,
    type ALReceiptRecordOpeningIssue
} from './validate-al-receipt-record-opening.ts';

export namespace ALReceiptRecord {
    export interface Dependencies {
        readonly backend: ALAdmissionWorkBackend;
        readonly namespace: string;
        readonly nowMs: () => number;
    }
    export interface View {
        readonly head: ALReceiptRecordHead;
        readonly tally: ALReceiptRecordTally;
    }
    export interface Conflict {
        readonly kind: 'conflict';
    }
    export interface HeadAbsent {
        readonly kind: 'head-absent';
    }
    export interface InvalidOpening {
        readonly kind: 'invalid-opening';
        readonly issues: readonly ALReceiptRecordOpeningIssue[];
    }
    export interface InvalidConfirmation {
        readonly kind: 'invalid-confirmation';
        readonly issues: readonly ALReceiptRecordConfirmationIssue[];
        readonly head: ALReceiptRecordHead;
    }
    export interface NotDue {
        readonly kind: 'not-due';
        readonly view: View;
    }
    export interface Counted {
        readonly disposition: 'counted' | 'repeated';
        readonly view: View;
    }
    export type CountedAhead = Counted | Readonly<{ disposition: 'ahead'; }>;
}

/** The head as the write that stored the confirmation read it; absent when no head was read. */
interface ConfirmationWrite {
    readonly disposition: ALReceiptRecord.Counted['disposition'];
    readonly head: ALReceiptRecordHead | undefined;
}

type ConfirmationWriteResult = ConfirmationWrite | ALReceiptRecord.InvalidConfirmation | ALReceiptRecord.Conflict;

interface HeadWrite {
    readonly head: ALReceiptRecordHead;
    readonly work: ALReceiptRecordWorkKind;
    readonly nowMs: number;
    readonly readyAtMs: number;
}

const CONFLICT: ALReceiptRecord.Conflict = { kind: 'conflict' };
const HEAD_ABSENT: ALReceiptRecord.HeadAbsent = { kind: 'head-absent' };

export class ALReceiptRecord {
    private readonly backend: ALAdmissionWorkBackend;
    private readonly namespace: string;
    private readonly nowMs: () => number;

    constructor(dependencies: ALReceiptRecord.Dependencies) {
        this.backend = dependencies.backend;
        this.namespace = dependencies.namespace;
        this.nowMs = dependencies.nowMs;
    }

    async open(
        opening: ALReceiptRecordOpening
    ): Promise<Either<ALReceiptRecord.InvalidOpening | ALReceiptRecord.Conflict, ALReceiptRecord.View>> {
        const nowMs = this.nowMs();
        const issues = validateALReceiptRecordOpening(opening, nowMs);
        if (issues.length > 0) {
            return Either.ofLeft({ kind: 'invalid-opening', issues });
        }
        const head = { phase: 'open', opening } as const;
        const opened = await this.writeUnlessConflict(async (transaction) => {
            if ((await this.readHead(transaction, opening)) !== undefined) {
                throw new ALAdmissionBackendConflictError('AL receipt record is already open');
            }
            await this.writeHead(transaction, { head, work: 'deadline', nowMs, readyAtMs: opening.deadlineAtMs });
            return head;
        });
        return 'kind' in opened ? Either.ofLeft(opened) : Either.ofRight(await this.readView(opened));
    }

    async count(
        confirmation: ALReceiptRecordConfirmationDto
    ): Promise<
        Either<
            ALReceiptRecord.HeadAbsent | ALReceiptRecord.InvalidConfirmation | ALReceiptRecord.Conflict,
            ALReceiptRecord.Counted
        >
    > {
        const written = await this.writeConfirmation(confirmation, 'refuse');
        if ('kind' in written) {
            return Either.ofLeft(written);
        }
        const { disposition, head } = written;
        if (head !== undefined) {
            return Either.ofRight({ disposition, view: await this.readView(head) });
        }
        const read = await this.read(confirmation);
        return read.right === undefined
            ? Either.ofLeft(HEAD_ABSENT)
            : Either.ofRight({ disposition, view: read.right });
    }

    async countAhead(
        confirmation: ALReceiptRecordConfirmationDto
    ): Promise<Either<ALReceiptRecord.InvalidConfirmation | ALReceiptRecord.Conflict, ALReceiptRecord.CountedAhead>> {
        const written = await this.writeConfirmation(confirmation, 'write');
        if ('kind' in written) {
            return Either.ofLeft(written);
        }
        const read = await this.read(confirmation);
        return Either.ofRight(
            read.right === undefined
                ? { disposition: 'ahead' }
                : { disposition: written.disposition, view: read.right }
        );
    }

    async end(
        ref: ALReceiptRecordRef
    ): Promise<
        Either<ALReceiptRecord.HeadAbsent | ALReceiptRecord.NotDue | ALReceiptRecord.Conflict, ALReceiptRecordEndedHead>
    > {
        const nowMs = this.nowMs();
        const ended = await this.writeUnlessConflict(async (transaction) => {
            const [head, confirmations] = await Promise.all([
                this.readHead(transaction, ref),
                this.listConfirmations(transaction, ref)
            ]);
            if (head === undefined) {
                return HEAD_ABSENT;
            }
            if (head.phase !== 'open') {
                throw new ALAdmissionBackendConflictError('AL receipt record has already ended');
            }
            const tally = computeALReceiptRecordTally(head, confirmations);
            const ending = computeALReceiptRecordEnding({ head, tally, nowMs });
            if (ending.right === undefined) {
                return { kind: 'not-due', view: { head, tally } } as const;
            }
            await this.writeHead(transaction, {
                head: ending.right,
                work: 'ended',
                nowMs,
                readyAtMs: ending.right.endedAtEpochMs
            });
            return ending.right;
        });
        return 'kind' in ended ? Either.ofLeft(ended) : Either.ofRight(ended);
    }

    async read(ref: ALReceiptRecordRef): Promise<Either<ALReceiptRecord.HeadAbsent, ALReceiptRecord.View>> {
        const head = await this.readHead(this.backend, ref);
        return head === undefined ? Either.ofLeft(HEAD_ABSENT) : Either.ofRight(await this.readView(head));
    }

    private async readView(head: ALReceiptRecordHead): Promise<ALReceiptRecord.View> {
        const confirmations = head.phase === 'open' ? await this.listConfirmations(this.backend, head.opening) : [];
        return { head, tally: computeALReceiptRecordTally(head, confirmations) };
    }

    private writeConfirmation(
        confirmation: ALReceiptRecordConfirmationDto,
        whenHeadAbsent: 'refuse'
    ): Promise<ConfirmationWriteResult | ALReceiptRecord.HeadAbsent>;
    private writeConfirmation(
        confirmation: ALReceiptRecordConfirmationDto,
        whenHeadAbsent: 'write'
    ): Promise<ConfirmationWriteResult>;
    private async writeConfirmation(
        confirmation: ALReceiptRecordConfirmationDto,
        whenHeadAbsent: 'refuse' | 'write'
    ): Promise<ConfirmationWriteResult | ALReceiptRecord.HeadAbsent> {
        const nowMs = this.nowMs();
        const key = toALReceiptRecordConfirmationKey(this.namespace, confirmation, confirmation.recipientPeerId);
        const decode = toALReceiptRecordConfirmationDecoder(this.namespace, confirmation);
        const row: ALReceiptRecordConfirmation = {
            recipientPeerId: confirmation.recipientPeerId,
            kind: confirmation.kind,
            countedAtEpochMs: nowMs
        };
        const written = await this.writeUnlessConflict(async (transaction) => {
            const [head, stored] = await Promise.all([
                this.readHead(transaction, confirmation),
                transaction.read(key, decode)
            ]);
            if (head === undefined && whenHeadAbsent === 'refuse') {
                return HEAD_ABSENT;
            }
            const issues = head === undefined ? [] : validateALReceiptRecordConfirmation(head, confirmation, nowMs);
            if (head !== undefined && issues.length > 0) {
                return { kind: 'invalid-confirmation', issues, head } as const;
            }
            if (stored === undefined) {
                await transaction.set(key, row, computeConfirmationExpiryMs(head, nowMs));
            }
            return { disposition: stored === undefined ? 'counted' : 'repeated', head } as const;
        });
        if (!('kind' in written) || written.kind !== 'conflict') {
            return written;
        }
        const repeated = await this.backend.read(key, decode);
        return repeated === undefined ? CONFLICT : { disposition: 'repeated', head: undefined };
    }

    private async writeHead(transaction: ALAdmissionWorkWriteContext, write: HeadWrite): Promise<void> {
        const { opening } = write.head;
        const expireAtTimestamp = computeALReceiptRetentionExpiryMs(Math.max(opening.deadlineAtMs, write.readyAtMs));
        const entry = computeALReceiptRecordWorkEntry({
            namespace: this.namespace,
            work: { kind: write.work, ref: opening },
            observedAtMs: write.nowMs,
            readyAtMs: write.readyAtMs,
            expireAtTimestamp
        });
        await transaction.setFence(toALReceiptRecordHeadKey(this.namespace, opening), write.head, expireAtTimestamp);
        await transaction.readWork(entry.key);
        transaction.writeWork(entry);
    }

    private async readHead(
        context: ALAdmissionReadContext,
        ref: ALReceiptRecordRef
    ): Promise<ALReceiptRecordHead | undefined> {
        return await context.read(toALReceiptRecordHeadKey(this.namespace, ref), decodeALReceiptRecordHead);
    }

    private async listConfirmations(
        context: ALAdmissionReadContext,
        ref: ALReceiptRecordRef
    ): Promise<readonly ALReceiptRecordConfirmation[]> {
        const entries = await context.list(
            toALReceiptRecordConfirmationPrefix(this.namespace, ref),
            toALReceiptRecordConfirmationDecoder(this.namespace, ref)
        );
        return entries.map(({ value }) => value);
    }

    private async writeUnlessConflict<T>(
        operation: (transaction: ALAdmissionWorkWriteContext) => Promise<T>
    ): Promise<T | ALReceiptRecord.Conflict> {
        try {
            return await this.backend.write(operation);
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return CONFLICT;
            }
            throw error;
        }
    }
}

/**
 * A confirmation under a head outlives the open head by one grace, so an `end` that reads a live head also reads every
 * confirmation counted under it, however late it runs.
 */
function computeConfirmationExpiryMs(head: ALReceiptRecordHead | undefined, nowMs: number): number {
    return head === undefined
        ? nowMs + AL_RECEIPT_RECORD_WINDOW_MS + AL_RECEIPT_DEADLINE_GRACE_MS
        : computeALReceiptRetentionExpiryMs(head.opening.deadlineAtMs) + AL_RECEIPT_DEADLINE_GRACE_MS;
}

/**
 * The confirmation decoder checks a key by its suffix alone; a prefix list returns rows under any key, so the record,
 * which knows its namespace and ref, requires the exact key.
 */
function toALReceiptRecordConfirmationDecoder(
    namespace: string,
    ref: ALReceiptRecordRef
): ALAdmissionDecoder<ALReceiptRecordConfirmation> {
    return (value, key) => {
        const confirmation = decodeALReceiptRecordConfirmation(value, key);
        if (key !== toALReceiptRecordConfirmationKey(namespace, ref, confirmation.recipientPeerId)) {
            throw new TypeError('Stored receipt confirmation lies under another recipient\'s key');
        }
        return confirmation;
    };
}
