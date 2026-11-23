import { describe, expect, it } from 'vitest';

import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    toALReceiptRecordConfirmationKey,
    toALReceiptRecordConfirmationPrefix,
    type ALReceiptRecordRef
} from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import {
    decodeALReceiptRecordConfirmation,
    type ALReceiptRecordOpening
} from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import {
    decodeALReceiptRecordWorkEntry,
    toALReceiptRecordWorkKey,
    toALReceiptRecordWorkType
} from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import type { ALReceiptRecordConfirmationDto } from '@shared/alm/receipt-record/validate-al-receipt-record-confirmation.ts';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

/** Any lease longer than a case: no claim in these cases is released or swept. */
const CLAIM_LEASE_MS = 10_000;

export interface ALReceiptRecordContractInstance {
    readonly record: ALReceiptRecord;
    readonly backend: ALAdmissionWorkBackend;
    readonly clock: { nowMs: number; };
}

/**
 * One store as the cases see it. Each `createScope` call returns a namespace of its own, holding no other scope's
 * rows: a case may create several scopes, and one claims every due work row of the record's type in its namespace.
 */
export interface ALReceiptRecordContractScope {
    readonly namespace: string;
    /** Three server instances over one store, each on its own clock. */
    readonly instances: readonly [
        ALReceiptRecordContractInstance,
        ALReceiptRecordContractInstance,
        ALReceiptRecordContractInstance
    ];
    /**
     * The clock on which a fenced write takes an expired row that no sweep has deleted as gone. Reads expire rows on
     * the instance clock; PostgreSQL's conditional inserts compare with the database clock, which no case can move.
     */
    readonly fencedWriteClock: 'instance' | 'database';
}

interface ContractFixture {
    readonly scope: ALReceiptRecordContractScope;
    readonly a: ALReceiptRecordContractInstance;
    readonly b: ALReceiptRecordContractInstance;
    readonly c: ALReceiptRecordContractInstance;
    readonly ref: ALReceiptRecordRef;
    readonly startMs: number;
    readonly opening: ALReceiptRecordOpening;
}

async function createFixture(createScope: () => Promise<ALReceiptRecordContractScope>): Promise<ContractFixture> {
    const scope = await createScope();
    const [a, b, c] = scope.instances;
    const ref = { originPeerId: 'origin', msgId: `msg-${crypto.randomUUID()}` };
    const startMs = a.clock.nowMs;
    // Two recipients and a 5 s deadline: the smallest audience that can be partly confirmed, and a deadline far
    // inside the record window, so the deadline, not the window, bounds every row.
    const opening = toOpening(ref, ['r1', 'r2'], startMs + 5_000);
    return { scope, a, b, c, ref, startMs, opening };
}

function toOpening(
    ref: ALReceiptRecordRef,
    expectedRecipientPeerIds: readonly string[],
    deadlineAtMs: number
): ALReceiptRecordOpening {
    return { ...ref, traceId: 'trace', expectedRecipientPeerIds, snapshotVersion: 1, deadlineAtMs };
}

function toConfirmation(
    ref: ALReceiptRecordRef,
    recipientPeerId: string,
    kind: ALReceiptRecordConfirmationDto['kind'] = 'confirmed'
): ALReceiptRecordConfirmationDto {
    return { ...ref, recipientPeerId, kind };
}

function setClocks(fixture: ContractFixture, nowMs: number): void {
    for (const instance of fixture.scope.instances) {
        instance.clock.nowMs = nowMs;
    }
}

function confirm(fixture: ContractFixture, instance: ALReceiptRecordContractInstance, recipientPeerId: string) {
    return instance.record.count(toConfirmation(fixture.ref, recipientPeerId));
}

async function readStoredConfirmations(fixture: ContractFixture, ref: ALReceiptRecordRef = fixture.ref) {
    return await fixture.a.backend.list(
        toALReceiptRecordConfirmationPrefix(fixture.scope.namespace, ref),
        decodeALReceiptRecordConfirmation
    );
}

async function readWork(fixture: ContractFixture, kind: 'deadline' | 'ended') {
    return await fixture.a.backend.workQueue.getItem(toALReceiptRecordWorkKey(fixture.scope.namespace, kind, fixture.ref));
}

async function openWith(fixture: ContractFixture, confirmed: readonly string[]): Promise<void> {
    expect((await fixture.a.record.open(fixture.opening)).right).toBeDefined();
    for (const recipientPeerId of confirmed) {
        expect((await confirm(fixture, fixture.a, recipientPeerId)).right?.disposition).toBe('counted');
    }
}

function toTally(view: ALReceiptRecord.View | undefined) {
    return view === undefined ? undefined : {
        confirmed: view.tally.confirmedRecipientPeerIds,
        outside: view.tally.outsideAudienceRecipientPeerIds,
        complete: view.tally.complete
    };
}

function claimWork(instance: ALReceiptRecordContractInstance, workType: string) {
    const nowMs = () => instance.clock.nowMs;
    return createALWorkQueuePort({
        queue: instance.backend.workQueue,
        workTypes: new Set([workType]),
        leaseMs: CLAIM_LEASE_MS,
        nowMs,
        random: Math.random,
        leaseRecovery: createLimitedALWorkLeaseRecovery(CLAIM_LEASE_MS, nowMs())
    }).claim({ maxCount: 10, observedEntries: undefined });
}

async function waitForWallClockPast(epochMs: number): Promise<void> {
    while (Date.now() <= epochMs) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

export function describeALReceiptRecordContract(
    label: string,
    createScope: () => Promise<ALReceiptRecordContractScope>
): void {
    describe(`ALReceiptRecord contract (${label})`, () => {
        const fixture = () => createFixture(createScope);

        // The head and its deadline work commit together: a head without work would never end, work without a head
        // would end nothing. A second open must not replace the frozen audience another instance already counts.
        it('opens a head with its deadline work in one commit', async () => {
            const f = await fixture();
            const opened = await f.a.record.open(f.opening);

            expect(opened.right?.head).toEqual({ phase: 'open', opening: f.opening });
            expect(toTally(opened.right)).toEqual({ confirmed: [], outside: [], complete: false });
            const work = await readWork(f, 'deadline');
            expect(work?.status).toBe(EntityStatus.NEW);
            expect(work?.typeId).toBe(toALReceiptRecordWorkType(f.scope.namespace));
            expect(work?.dequeueAudit.nextTs?.epochMilliseconds).toBe(f.startMs + 5_000);
            expect(work?.audit.expiryTs.epochMilliseconds).toBe(f.startMs + 35_000);

            expect((await f.b.record.open(f.opening)).left).toEqual({ kind: 'conflict' });
            expect((await f.c.record.read(f.ref)).right?.head).toEqual({ phase: 'open', opening: f.opening });
            expect(await readWork(f, 'deadline')).toEqual(work);
        });

        // An empty audience can never complete and a deadline past the window outlives the rows that count it, so
        // both are refused whole, before any row exists.
        it('refuses an opening it cannot bound, writing nothing', async () => {
            const f = await fixture();
            const opened = await f.a.record.open({
                ...f.opening,
                expectedRecipientPeerIds: [],
                deadlineAtMs: f.startMs + 1_800_001
            });

            expect(opened.left?.kind).toBe('invalid-opening');
            expect(opened.left?.kind === 'invalid-opening' ? opened.left.issues.map(({ code }) => code) : [])
                .toEqual(['empty-audience', 'deadline-beyond-window']);
            expect((await f.b.record.read(f.ref)).left).toEqual({ kind: 'head-absent' });
            expect(await readWork(f, 'deadline')).toBeUndefined();
        });

        // Each recipient writes its own unfenced row, so ACKs counted on different instances at once must neither
        // conflict nor lose one another; whichever count reads last sees the whole set.
        it('counts concurrent confirmations from three instances without a conflict', async () => {
            const f = await fixture();
            const recipients = Array.from({ length: 15 }, (_, index) => `r${String(index + 1).padStart(2, '0')}`);
            await f.a.record.open(toOpening(f.ref, recipients, f.startMs + 5_000));

            const results = await Promise.all(recipients.map((recipientPeerId, index) => confirm(f, f.scope.instances[index % 3], recipientPeerId)));

            expect(results.map((result) => result.right?.disposition)).toEqual(recipients.map(() => 'counted'));
            expect(results.some((result) => result.right?.view.tally.complete === true)).toBe(true);
            expect(toTally((await f.b.record.read(f.ref)).right)?.confirmed).toEqual(recipients);
        });

        // A resent ACK, even one that now claims another kind, must not count a recipient twice or change how it was
        // counted: the first write wins and the repeat is a typed no-op.
        it('counts a repeated confirmation once', async () => {
            const f = await fixture();
            await f.a.record.open(f.opening);

            expect((await confirm(f, f.a, 'r1')).right?.disposition).toBe('counted');
            expect((await confirm(f, f.b, 'r1')).right?.disposition).toBe('repeated');
            expect(await readStoredConfirmations(f)).toHaveLength(1);
            const outside = await f.b.record.count(toConfirmation(f.ref, 'r1', 'outside'));
            expect(outside.right?.disposition).toBe('repeated');
            expect((await readStoredConfirmations(f))[0]?.value.kind).toBe('confirmed');

            const raced = await Promise.all([confirm(f, f.a, 'r2'), confirm(f, f.b, 'r2')]);
            expect(raced.map((result) => result.right?.disposition).sort()).toEqual(['counted', 'repeated']);
        });

        // Ending is fenced on the open head: of several instances ending one receipt, one commits and writes one
        // terminal receipt's work; the others read a conflict, so no receipt is sent twice.
        it('ends one receipt once when three instances end it together', async () => {
            const f = await fixture();
            await openWith(f, ['r1', 'r2']);

            const ended = await Promise.all(f.scope.instances.map((instance) => instance.record.end(f.ref)));

            const committed = ended.flatMap((result) => result.right === undefined ? [] : [result.right]);
            expect(committed).toHaveLength(1);
            expect(committed[0]?.phase).toBe('complete');
            expect(committed[0]?.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
            expect(ended.filter((result) => result.left !== undefined).map((result) => result.left))
                .toEqual([{ kind: 'conflict' }, { kind: 'conflict' }]);
            const endedAtMs = committed[0]?.endedAtEpochMs ?? Number.NaN;
            const work = await readWork(f, 'ended');
            expect(work?.status).toBe(EntityStatus.NEW);
            expect(work?.dequeueAudit.nextTs?.epochMilliseconds).toBe(endedAtMs);
            expect(work?.audit.expiryTs.epochMilliseconds).toBe(Math.max(f.startMs + 5_000, endedAtMs) + 30_000);
        });

        // The deadline pass and the last ACK race on different instances. Whichever wins, the receipt holds one
        // terminal phase and its sets agree with it: never 'timed-out' naming both, never 'complete' missing one.
        it('holds one terminal phase when the deadline pass races the last confirmation', async () => {
            const f = await fixture();
            await openWith(f, ['r1']);
            f.b.clock.nowMs = f.startMs + 5_000;

            await Promise.all([confirm(f, f.a, 'r2'), f.b.record.end(f.ref)]);

            const first = await f.c.record.read(f.ref);
            const head = first.right?.head;
            expect(head?.phase === 'complete' || head?.phase === 'timed-out').toBe(true);
            expect(toTally(first.right)?.confirmed).toEqual(head?.phase === 'complete' ? ['r1', 'r2'] : ['r1']);
            expect((await f.a.record.end(f.ref)).left).toEqual({ kind: 'conflict' });
            expect((await f.c.record.end(f.ref)).left).toEqual({ kind: 'conflict' });
            expect(await f.c.record.read(f.ref)).toEqual(first);
        });

        // D696's race: the ACK overtakes the admitting instance's open. `count` refuses to write without a head,
        // `countAhead` writes, and the open that follows counts it. The row must outlive the 30 s grace, because
        // while the head is open the rows are the count (decision 1).
        it('counts an ACK that arrived before its head', async () => {
            const f = await fixture();

            expect((await confirm(f, f.a, 'r1')).left).toEqual({ kind: 'head-absent' });
            expect(await readStoredConfirmations(f)).toEqual([]);
            expect((await f.a.record.countAhead(toConfirmation(f.ref, 'r1'))).right).toEqual({ disposition: 'ahead' });

            const opened = await f.b.record.open(toOpening(f.ref, ['r1'], f.startMs + 600_000));
            expect(opened.right?.tally.complete).toBe(true);
            const repeated = await f.c.record.countAhead(toConfirmation(f.ref, 'r1'));
            expect(repeated.right?.disposition).toBe('repeated');
            expect(repeated.right?.disposition === 'ahead' ? undefined : repeated.right?.view.head.phase).toBe('open');

            setClocks(f, f.startMs + 300_000);
            expect(toTally((await f.a.record.read(f.ref)).right)?.confirmed).toEqual(['r1']);
        });

        // An ACK that validated just before another instance ended the head may still write its row; after the end
        // the head's own sets are the receipt, so that row must not change what is read.
        it('ignores a confirmation that lands after the end', async () => {
            const f = await fixture();
            await openWith(f, ['r1']);
            setClocks(f, f.startMs + 5_000);
            expect((await f.a.record.end(f.ref)).right?.phase).toBe('timed-out');

            const late = await confirm(f, f.b, 'r2');
            expect(late.left?.kind).toBe('invalid-confirmation');
            expect(late.left?.kind === 'invalid-confirmation' ? late.left.issues.map(({ code }) => code) : [])
                .toEqual(['head-ended']);

            await f.b.backend.write(async (transaction) => {
                await transaction.set(
                    toALReceiptRecordConfirmationKey(f.scope.namespace, f.ref, 'r2'),
                    { recipientPeerId: 'r2', kind: 'confirmed', countedAtEpochMs: f.startMs + 4_999 },
                    f.startMs + 35_000
                );
            });
            const read = await f.c.record.read(f.ref);
            expect(read.right?.head.phase).toBe('timed-out');
            expect(toTally(read.right)).toEqual({ confirmed: ['r1'], outside: [], complete: false });
        });

        // A session may write at most one row per message that expects it; a stranger writes none.
        it('writes nothing for an ACK from outside the expected set', async () => {
            const f = await fixture();
            await f.a.record.open(f.opening);

            const counted = await confirm(f, f.a, 'stranger');
            expect(counted.left?.kind).toBe('invalid-confirmation');
            if (counted.left?.kind === 'invalid-confirmation') {
                expect(counted.left.issues.map(({ code }) => code)).toEqual(['outside-frozen-audience']);
                expect(counted.left.head.phase).toBe('open');
            }
            expect(await readStoredConfirmations(f)).toEqual([]);
        });

        // At the deadline the deadline pass may already be ending the receipt; an ACK then would race it.
        it('refuses a confirmation at its deadline', async () => {
            const f = await fixture();
            await f.a.record.open(f.opening);
            f.a.clock.nowMs = f.startMs + 5_000;

            const counted = await confirm(f, f.a, 'r1');
            expect(counted.left?.kind === 'invalid-confirmation' ? counted.left.issues.map(({ code }) => code) : [])
                .toEqual(['deadline-expired']);
            expect(await readStoredConfirmations(f)).toEqual([]);
        });

        // Every row is bounded: an open head at deadline + grace and its confirmations one grace later, so an `end`
        // that reads a live head always reads its confirmations too; an ended head at the later of its deadline and
        // its end plus grace; an early confirmation at the latest a head opened after it could need.
        it('expires a receipt with the receipt grace', async () => {
            const f = await fixture();
            await openWith(f, ['r1']);
            setClocks(f, f.startMs + 34_999);
            expect((await f.a.record.read(f.ref)).right).toBeDefined();
            setClocks(f, f.startMs + 35_000);
            expect((await f.a.record.read(f.ref)).left).toEqual({ kind: 'head-absent' });
            expect((await readStoredConfirmations(f)).map(({ value }) => value.recipientPeerId)).toEqual(['r1']);
            setClocks(f, f.startMs + 64_999);
            expect(await readStoredConfirmations(f)).toHaveLength(1);
            setClocks(f, f.startMs + 65_000);
            expect(await readStoredConfirmations(f)).toEqual([]);

            const complete = await createFixture(createScope);
            await openWith(complete, ['r1', 'r2']);
            setClocks(complete, complete.startMs + 1_000);
            expect((await complete.a.record.end(complete.ref)).right?.phase).toBe('complete');
            setClocks(complete, complete.startMs + 34_999);
            expect((await complete.b.record.read(complete.ref)).right?.head.phase).toBe('complete');
            setClocks(complete, complete.startMs + 35_000);
            expect((await complete.b.record.read(complete.ref)).left).toEqual({ kind: 'head-absent' });

            const timedOut = await createFixture(createScope);
            await openWith(timedOut, ['r1']);
            setClocks(timedOut, timedOut.startMs + 20_000);
            expect((await timedOut.a.record.end(timedOut.ref)).right?.phase).toBe('timed-out');
            setClocks(timedOut, timedOut.startMs + 49_999);
            expect((await timedOut.b.record.read(timedOut.ref)).right?.head.phase).toBe('timed-out');
            setClocks(timedOut, timedOut.startMs + 50_000);
            expect((await timedOut.b.record.read(timedOut.ref)).left).toEqual({ kind: 'head-absent' });

            const ahead = await createFixture(createScope);
            await ahead.a.record.countAhead(toConfirmation(ahead.ref, 'r1'));
            setClocks(ahead, ahead.startMs + 1_829_999);
            expect(await readStoredConfirmations(ahead)).toHaveLength(1);
            setClocks(ahead, ahead.startMs + 1_830_000);
            expect(await readStoredConfirmations(ahead)).toEqual([]);
        });

        // Review Focus 1: a separator-joined key would give 'm' plus ':x' and 'm:x' one prefix, and an origin
        // holding a quote and bracket could close the JSON pair early; each receipt must count only its own rows.
        it('keeps receipts of look-alike ids apart', async () => {
            const f = await fixture();
            const pairs: readonly (readonly [ALReceiptRecordRef, ALReceiptRecordRef])[] = [
                [{ originPeerId: 'o', msgId: 'm' }, { originPeerId: 'o', msgId: 'm:x' }],
                [{ originPeerId: 'o', msgId: f.ref.msgId }, { originPeerId: 'o"]', msgId: f.ref.msgId }]
            ];
            for (const [first, second] of pairs) {
                await f.a.record.open(toOpening(first, ['r1'], f.startMs + 5_000));
                await f.a.record.open(toOpening(second, ['r1'], f.startMs + 5_000));
                await f.b.record.count(toConfirmation(first, 'r1'));

                expect(toTally((await f.c.record.read(first)).right)?.confirmed).toEqual(['r1']);
                expect(toTally((await f.c.record.read(second)).right))
                    .toEqual({ confirmed: [], outside: [], complete: false });
            }
        });

        // A worker claims by work type: the record's rows must reach only a record worker, never an outbound one.
        // The PostgreSQL queue reads the database clock in places, so real time also passes the deadline.
        it('leaves its work to its own work type', async () => {
            const f = await fixture();
            await f.a.record.open({ ...f.opening, deadlineAtMs: f.startMs + 1 });
            setClocks(f, f.startMs + 1_000);
            await waitForWallClockPast(f.startMs + 1);

            expect(await claimWork(f.a, toALOutboundWorkType(f.scope.namespace))).toEqual([]);
            const claimed = await claimWork(f.b, toALReceiptRecordWorkType(f.scope.namespace));
            expect(claimed.map((claim) => decodeALReceiptRecordWorkEntry(claim.entry, f.scope.namespace)))
                .toEqual([{ kind: 'deadline', ref: f.ref }]);
        });

        // The deadline pass must not end a receipt early, and when it does end one it names who confirmed so far.
        it('times out naming the recipients confirmed so far', async () => {
            const f = await fixture();
            await openWith(f, ['r1']);

            setClocks(f, f.startMs + 4_999);
            const early = await f.b.record.end(f.ref);
            expect(early.left?.kind).toBe('not-due');
            expect(early.left?.kind === 'not-due' ? early.left.view.tally.confirmedRecipientPeerIds : []).toEqual(['r1']);
            expect((await f.c.record.read(f.ref)).right?.head.phase).toBe('open');

            setClocks(f, f.startMs + 5_000);
            const ended = await f.b.record.end(f.ref);
            expect(ended.right?.phase).toBe('timed-out');
            expect(ended.right?.confirmedRecipientPeerIds).toEqual(['r1']);
            expect(ended.right?.outsideAudienceRecipientPeerIds).toEqual([]);
            expect(ended.right?.endedAtEpochMs).toBe(f.startMs + 5_000);
        });

        // The crash window: the last confirmation committed and its instance died before `end`. The deadline pass
        // must end such a receipt 'complete', never 'timed-out'.
        it('ends complete at the deadline when the set was complete under an open head', async () => {
            const f = await fixture();
            await openWith(f, ['r1', 'r2']);
            setClocks(f, f.startMs + 5_000);

            expect((await f.c.record.end(f.ref)).right?.phase).toBe('complete');
        });

        // A set answered only from outside the audience delivered nothing; it must time out, not complete.
        it('never completes a set nobody confirmed', async () => {
            const f = await fixture();
            await f.a.record.open(f.opening);
            await f.a.record.count(toConfirmation(f.ref, 'r1', 'outside'));
            const counted = await f.b.record.count(toConfirmation(f.ref, 'r2', 'outside'));
            expect(counted.right?.view.tally.complete).toBe(false);

            setClocks(f, f.startMs + 5_000);
            const ended = await f.c.record.end(f.ref);
            expect(ended.right?.phase).toBe('timed-out');
            expect(ended.right?.outsideAudienceRecipientPeerIds).toEqual(['r1', 'r2']);
        });

        // Ruling 5: a re-sent copy is answered after the end too, from the head alone, on any instance.
        it('answers an ended receipt from the head alone', async () => {
            const f = await fixture();
            await openWith(f, ['r1', 'r2']);
            const ended = await f.a.record.end(f.ref);

            const read = await f.c.record.read(f.ref);
            expect(read.right?.head).toEqual(ended.right);
            expect(toTally(read.right)).toEqual({ confirmed: ['r1', 'r2'], outside: [], complete: true });
        });

        // Ruling R6: a loose key check ('ends with :r1') would read recipient a:r1's key as r1's. The record knows
        // its namespace and ref, so a row stored under another recipient's key fails closed, never counted.
        it('keeps a recipient whose id contains a colon apart from its look-alike', async () => {
            const f = await fixture();
            await f.a.record.open(toOpening(f.ref, ['a:r1', 'r1'], f.startMs + 5_000));

            const first = await confirm(f, f.b, 'r1');
            expect(toTally(first.right?.view)).toEqual({ confirmed: ['r1'], outside: [], complete: false });
            const second = await confirm(f, f.c, 'a:r1');
            expect(toTally(second.right?.view)?.confirmed).toEqual(['a:r1', 'r1']);

            await f.a.backend.write(async (transaction) => {
                await transaction.set(
                    toALReceiptRecordConfirmationKey(f.scope.namespace, f.ref, 'a:r1'),
                    { recipientPeerId: 'r1', kind: 'confirmed', countedAtEpochMs: f.startMs },
                    f.startMs + 35_000
                );
            });
            await expect(f.b.record.read(f.ref)).rejects.toThrow(ALAdmissionCorruptionError);
        });

        // An audience that names r1 twice must not wait for a second ACK from r1, nor name r1 twice in any set the
        // tally, the terminal head or a later read reports.
        it('names a repeated recipient once', async () => {
            const f = await fixture();
            await f.a.record.open(toOpening(f.ref, ['r1', 'r1', 'r2'], f.startMs + 5_000));

            const first = await confirm(f, f.b, 'r1');
            expect(first.right?.view.tally).toEqual({
                confirmedRecipientPeerIds: ['r1'],
                outsideAudienceRecipientPeerIds: [],
                complete: false
            });
            expect((await confirm(f, f.c, 'r2')).right?.view.tally.complete).toBe(true);

            const ended = await f.a.record.end(f.ref);
            expect(ended.right?.phase).toBe('complete');
            expect(ended.right?.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
            expect(toTally((await f.b.record.read(f.ref)).right))
                .toEqual({ confirmed: ['r1', 'r2'], outside: [], complete: true });
        });

        // A deadline pass one grace late reads the head and then the confirmations: were they to expire with the
        // head, it could read a live head and no confirmation, and end a complete receipt 'timed-out' naming nobody.
        it('ends on the confirmations it read when the deadline pass runs late', async () => {
            const f = await fixture();
            await openWith(f, ['r1', 'r2']);
            f.b.clock.nowMs = f.startMs + 34_999;

            const ended = await f.b.record.end(f.ref);
            expect(ended.right?.phase).toBe('complete');
            expect(ended.right?.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
        });

        // The sibling: a late pass over a partial set must name the recipient that did confirm.
        it('times out naming the confirmations it read when the deadline pass runs late', async () => {
            const f = await fixture();
            await openWith(f, ['r1']);
            f.b.clock.nowMs = f.startMs + 34_999;

            const ended = await f.b.record.end(f.ref);
            expect(ended.right?.phase).toBe('timed-out');
            expect(ended.right?.confirmedRecipientPeerIds).toEqual(['r1']);
        });

        // Decision 5: a receipt past its grace is gone. Opening it again would write a head no row bounds and a
        // deadline that has already passed, so the same opening is refused whole and writes nothing.
        it('refuses to open again a receipt whose deadline has passed its grace', async () => {
            const f = await fixture();
            expect((await f.a.record.open(f.opening)).right).toBeDefined();
            setClocks(f, f.startMs + 35_000);

            const reopened = await f.b.record.open(f.opening);
            expect(reopened.left?.kind === 'invalid-opening' ? reopened.left.issues.map(({ code }) => code) : [])
                .toEqual(['receipt-expired']);
            expect((await f.c.record.read(f.ref)).left).toEqual({ kind: 'head-absent' });
            expect(await readWork(f, 'deadline')).toBeUndefined();
        });

        // A characterization the next slice must guard against, not a promise: once the head has expired, the same
        // ref opens a second life under a later deadline, with a fresh tally and one deadline work row due then. Where
        // fenced writes read the database clock, the first life's unswept rows still hold the slot for the instance
        // clocks moved here, so the reopen conflicts; with real clocks it opens once the database clock passes them.
        it('opens a second life only under a later deadline', async () => {
            const f = await fixture();
            expect((await f.a.record.open(f.opening)).right).toBeDefined();
            setClocks(f, f.startMs + 35_000);

            const reopened = await f.b.record.open(toOpening(f.ref, ['r1', 'r2'], f.startMs + 600_000));
            const page = await f.a.backend.workQueue.readWorkPage({
                typeId: toALReceiptRecordWorkType(f.scope.namespace),
                status: EntityStatus.NEW,
                maxToRead: 10,
                order: 'key',
                cursor: null
            });
            expect(page.entries.map((entry) => decodeALReceiptRecordWorkEntry(entry, f.scope.namespace)))
                .toEqual([{ kind: 'deadline', ref: f.ref }]);
            if (f.scope.fencedWriteClock === 'database') {
                expect(reopened.left).toEqual({ kind: 'conflict' });
                expect(page.entries[0]?.dequeueAudit.nextTs?.epochMilliseconds).toBe(f.startMs + 5_000);
                return;
            }
            expect(toTally(reopened.right)).toEqual({ confirmed: [], outside: [], complete: false });
            expect(page.entries[0]?.dequeueAudit.nextTs?.epochMilliseconds).toBe(f.startMs + 600_000);
        });

        // An end with no head to fence would have no frozen audience to end on; it must write no ended work, which a
        // worker would otherwise send as a terminal receipt.
        it('ends nothing when there is no head', async () => {
            const f = await fixture();
            expect((await f.a.record.end(f.ref)).left).toEqual({ kind: 'head-absent' });
            expect(await readWork(f, 'ended')).toBeUndefined();

            expect((await f.a.record.open(f.opening)).right).toBeDefined();
            setClocks(f, f.startMs + 35_000);
            expect((await f.b.record.end(f.ref)).left).toEqual({ kind: 'head-absent' });
            expect(await readWork(f, 'ended')).toBeUndefined();
        });

        // Once the head is there `countAhead` is `count`: it validates against the head, and the row it writes takes
        // the head's confirmation expiry (deadline plus two graces), not the half-hour expiry of a row with no head.
        it('counts ahead as count does once the head is there', async () => {
            const f = await fixture();
            await f.a.record.open(f.opening);
            const refusedAsCount = async (
                instance: ALReceiptRecordContractInstance,
                recipientPeerId: string,
                code: string
            ) => {
                const ahead = await instance.record.countAhead(toConfirmation(f.ref, recipientPeerId));
                expect(ahead.left?.kind === 'invalid-confirmation' ? ahead.left.issues.map((issue) => issue.code) : [])
                    .toEqual([code]);
                expect(ahead.left).toEqual((await confirm(f, instance, recipientPeerId)).left);
            };

            await refusedAsCount(f.a, 'stranger', 'outside-frozen-audience');
            expect((await f.b.record.countAhead(toConfirmation(f.ref, 'r1'))).right?.disposition).toBe('counted');
            setClocks(f, f.startMs + 5_000);
            await refusedAsCount(f.c, 'r2', 'deadline-expired');
            expect((await f.a.record.end(f.ref)).right?.phase).toBe('timed-out');
            await refusedAsCount(f.b, 'r2', 'head-ended');
            expect((await readStoredConfirmations(f)).map(({ value }) => value.recipientPeerId)).toEqual(['r1']);

            setClocks(f, f.startMs + 64_999);
            expect(await readStoredConfirmations(f)).toHaveLength(1);
            setClocks(f, f.startMs + 65_000);
            expect(await readStoredConfirmations(f)).toEqual([]);
        });

        // `countAhead` with no head checks no deadline. An ACK that arrived a second after a deadline, before its
        // still-graced head was opened, is one `count` would refuse: the head must neither count it nor complete on it.
        it('ignores an ACK that arrived ahead but after the deadline', async () => {
            const f = await fixture();
            setClocks(f, f.startMs + 6_000);
            expect((await f.a.record.countAhead(toConfirmation(f.ref, 'r1'))).right).toEqual({ disposition: 'ahead' });

            const opened = await f.b.record.open(toOpening(f.ref, ['r1'], f.startMs + 5_000));
            expect(toTally(opened.right)).toEqual({ confirmed: [], outside: [], complete: false });
            const ended = await f.c.record.end(f.ref);
            expect(ended.right?.phase).toBe('timed-out');
            expect(ended.right?.confirmedRecipientPeerIds).toEqual([]);
        });
    });
}
