import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';

import { createOriginSnapshot, createRtcOriginOverlayFixture } from './rtc-origin-overlay-fixture.ts';

function createAck(sequence: number) {
    return newALAckControlMessage(
        { v: 3, msgId: `ack-${sequence}`, senderId: 'a', ts: Date.now() },
        {
            ackedMsgId: `subject-${sequence}`,
            fromPeerId: 'a',
            toPeerId: 'b',
            originPeerId: 'b',
            logicalRecipientPeerId: 'a',
            carrier: 'rtc',
            status: 'forwarded',
            observedAtEpochMs: Date.now()
        }
    );
}

describe('RTC enqueue protection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('refuses excess ACK controls without storage writes, then admits after the local quota window', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b']
        });
        for (let sequence = 0; sequence < 20; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createAck(sequence));
            expect(result.verdict.kind, result.reason).toBe('admitted');
        }
        for (let sequence = 20; sequence < 31; sequence++) {
            const message = createAck(sequence);
            const result = await fixture.manager.enqueueIfAbsent(message);
            expect(result.verdict).toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        }

        // The existing 1,000 ms limiter retains an overlapping 250 ms bucket at its edge.
        vi.setSystemTime(Date.now() + 1_251);
        const recovered = await fixture.manager.enqueueIfAbsent(createAck(31));
        expect(recovered.verdict.kind, recovered.reason).toBe('admitted');
    });

    it('recovers quota on its own clock while preserving independent admission time and precise creation', async () => {
        const quotaStartMs = 1791883286866;
        let quotaAtMs = quotaStartMs;
        let admissionAtMs = quotaStartMs + 20_000;
        vi.setSystemTime(admissionAtMs);
        const creationInstant = Temporal.Instant.from('2026-10-13T23:59:59.123456789Z');
        const creationNow = vi.fn(() => creationInstant);
        const quotaNow = vi.fn(() => quotaAtMs);
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            creationNow,
            quotaNow,
            rateLimiter: RateLimiter.initWithTs(1_000, 20, quotaStartMs)
        });
        vi.spyOn(fixture.resources.clock, 'nowMs').mockImplementation(() => admissionAtMs);

        for (let sequence = 0; sequence < 20; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createAck(sequence));
            expect(result.verdict.kind, result.reason).toBe('admitted');
            if (sequence === 0) {
                expect(result.entry?.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123456789');
                expect(result.entry?.audit.date.toString()).toBe('23:59:59.123456789');
            }
        }
        await vi.advanceTimersByTimeAsync(0);
        const creationCallsBeforeRefusal = creationNow.mock.calls.length;
        const controls = [createAck(100), createAck(101)];
        for (let observation = 0; observation < 2; observation++) {
            await expect(fixture.manager.handoffControlMessages(controls))
                .rejects.toMatchObject({ name: 'NotReadyException', delayMs: 1251 });
        }
        for (const control of controls) {
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
        }
        expect(creationNow).toHaveBeenCalledTimes(creationCallsBeforeRefusal);

        admissionAtMs += 10_000;
        await expect(fixture.manager.handoffControlMessages(controls))
            .rejects.toMatchObject({ name: 'NotReadyException', delayMs: 1251 });
        expect(creationNow).toHaveBeenCalledTimes(creationCallsBeforeRefusal);

        quotaAtMs = quotaStartMs + 1250;
        await expect(fixture.manager.handoffControlMessages(controls))
            .rejects.toMatchObject({ name: 'NotReadyException', delayMs: 1 });
        expect(creationNow).toHaveBeenCalledTimes(creationCallsBeforeRefusal);
        quotaAtMs = quotaStartMs + 1251;
        await fixture.manager.handoffControlMessages(controls);
        for (const control of controls) {
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(true);
        }
        expect(creationNow.mock.calls.length).toBeGreaterThan(creationCallsBeforeRefusal);
        for (let sequence = 200; sequence < 219; sequence++) {
            const admitted = await fixture.manager.enqueueIfAbsent(createAck(sequence));
            expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        }
        const refused = await fixture.manager.enqueueIfAbsent(createAck(219));
        expect(refused.verdict).toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission('ack-219')).toBe(false);
    });

    it('keeps real enqueue failures across neutral quota refusals and recovers through half-open', async () => {
        const circuitBreaker = toCircuitBreaker(1);
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker
        });
        for (let sequence = 0; sequence < 19; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createAck(sequence));
            expect(result.verdict.kind, result.reason).toBe('admitted');
        }

        vi.spyOn(fixture.resources.admissionStore, 'readOutgoingDecision')
            .mockRejectedValueOnce(new Error('test admission-store failure'));
        const firstFailure = await fixture.manager.enqueueIfAbsent(createAck(19));
        expect(firstFailure.verdict.kind).toBe('failed');

        for (const sequence of [20, 21]) {
            const message = createAck(sequence);
            const refused = await fixture.manager.enqueueIfAbsent(message);
            expect(refused.verdict).toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        }
        expect(circuitBreaker.isClosed()).toBe(true);

        vi.setSystemTime(Date.now() + 1_251);
        vi.spyOn(fixture.resources.admissionStore, 'readOutgoingDecision')
            .mockRejectedValueOnce(new Error('second test admission-store failure'));
        const secondFailure = await fixture.manager.enqueueIfAbsent(createAck(22));
        expect(secondFailure.verdict.kind).toBe('failed');
        expect(circuitBreaker.isOpen()).toBe(true);

        const suppressed = createAck(23);
        expect((await fixture.manager.enqueueIfAbsent(suppressed)).verdict)
            .toMatchObject({ kind: 'unroutable', reason: 'circuit-open' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(suppressed.id.msgId)).toBe(false);

        vi.setSystemTime(Date.now() + 10_001);
        const recovered = await fixture.manager.enqueueIfAbsent(createAck(24));
        expect(recovered.verdict.kind, recovered.reason).toBe('admitted');
        expect(circuitBreaker.isClosed()).toBe(true);
    });

    it('reports circuit-open first when both protections refuse an ACK', async () => {
        const circuitBreaker = toCircuitBreaker();
        const quotaNow = vi.fn(() => Date.now());
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker,
            quotaNow
        });
        for (let sequence = 0; sequence < 20; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createAck(sequence));
            expect(result.verdict.kind, result.reason).toBe('admitted');
        }
        circuitBreaker.failureCount(11);
        expect(circuitBreaker.isOpen()).toBe(true);

        quotaNow.mockClear();
        const suppressed = createAck(20);
        expect((await fixture.manager.enqueueIfAbsent(suppressed)).verdict)
            .toMatchObject({ kind: 'unroutable', reason: 'circuit-open' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(suppressed.id.msgId)).toBe(false);
        expect(quotaNow).not.toHaveBeenCalled();
    });

    it('reports disposal before the open circuit without observing either creation or quota time', async () => {
        const circuitBreaker = toCircuitBreaker();
        circuitBreaker.failureCount(11);
        const quotaNow = vi.fn(() => Date.now());
        const creationNow = vi.fn(() => Temporal.Now.instant());
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker,
            quotaNow,
            creationNow
        });
        await fixture.manager.dispose();

        const message = createAck(400);
        const result = await fixture.manager.enqueueIfAbsent(message);

        expect(result.verdict).toMatchObject({ kind: 'skipped', reason: 'disposed' });
        expect(quotaNow).not.toHaveBeenCalled();
        expect(creationNow).not.toHaveBeenCalled();
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
    });

    it('rechecks actual quota after a forecast and admits a whole control batch with one token', async () => {
        vi.useFakeTimers();
        const startedAtMs = 1791883286866;
        vi.setSystemTime(startedAtMs);
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b'], 1), nextHopPeerIds: ['b'] });
        const initial = await Promise.all(Array.from({ length: 20 }, (_, sequence) => fixture.manager.enqueueIfAbsent(createAck(sequence))));
        expect(initial.every((result) => result.verdict.kind === 'admitted' || result.verdict.kind === 'pending')).toBe(true);
        const controls = [createAck(100), createAck(101)];
        for (const read of [1, 2]) {
            await expect(fixture.manager.handoffControlMessages(controls), `nonspending forecast ${read}`)
                .rejects.toMatchObject({ name: 'NotReadyException', delayMs: 1251 });
        }
        for (const control of controls) {
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
        }
        vi.setSystemTime(startedAtMs + 1251);
        const competitors = await Promise.all(Array.from({ length: 21 }, (_, sequence) => fixture.manager.enqueueIfAbsent(createAck(200 + sequence))));
        expect(competitors.filter((result) => result.verdict.kind === 'admitted' || result.verdict.kind === 'pending')).toHaveLength(20);
        expect(competitors.filter((result) => result.verdict.kind === 'unroutable')).toHaveLength(1);
        await expect(fixture.manager.handoffControlMessages(controls)).rejects.toBeInstanceOf(NotReadyException);
        for (const control of controls) {
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
        }
        vi.setSystemTime(startedAtMs + 2501);
        await expect(fixture.manager.handoffControlMessages(controls)).rejects.toMatchObject({ delayMs: 1 });
        vi.setSystemTime(startedAtMs + 2502);
        await fixture.manager.handoffControlMessages(controls);
        for (const control of controls) {
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(true);
        }
        const afterBatch = await Promise.all(Array.from({ length: 20 }, (_, sequence) => fixture.manager.enqueueIfAbsent(createAck(300 + sequence))));
        expect(afterBatch.filter((result) => result.verdict.kind === 'admitted' || result.verdict.kind === 'pending')).toHaveLength(19);
        expect(afterBatch[19]!.verdict).toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
    });

    it('does not submit a control whose deadline passes during its admission handoff', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const startedAtMs = 1791883286866;
        vi.setSystemTime(startedAtMs);
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b'], 1), nextHopPeerIds: ['b'] });
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        onTestFinished(() => resume.resolve());
        const read = fixture.resources.admissionStore.readOutgoingDecision.bind(fixture.resources.admissionStore);
        vi.spyOn(fixture.resources.admissionStore, 'readOutgoingDecision').mockImplementationOnce(async (request, decide) => {
            const observed = await read(request, decide);
            entered.resolve();
            await resume.promise;
            return observed;
        });
        const control = { ...createAck(99), constraints: { expiresAtMs: startedAtMs + 1_000 } };
        const handoff = fixture.manager.handoffControlMessages([control]);
        const outcome = handoff.then(() => undefined, (caught) => caught);
        onTestFinished(async () => {
            const disposed = fixture.manager.dispose();
            resume.resolve();
            const outcomes = await Promise.allSettled([outcome, disposed]);
            for (const completion of outcomes) {
                if (completion.status === 'rejected') {
                    throw completion.reason;
                }
            }
        });
        await Promise.race([
            entered.promise,
            outcome.then((value) => {
                throw new Error(`Handoff finished before held read: ${String(value)}`);
            })
        ]);
        vi.setSystemTime(startedAtMs + 1_001);
        resume.resolve();
        expect(await outcome).toBeInstanceOf(NonRetryableException);
        await fixture.resources.queueEngine.stop();
        expect(fixture.channels.b!.sent.map((message) => message.id)).not.toContainEqual(control.id);
    });
});
