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
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { RateLimiter } from '@shared/resilience/rate-limiter.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

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

    it('hands off every ACK control inside one second without spending the quota own sends keep', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b']
        });
        // An ACK answers an inbound message its admission already bounded, so the hand-off spends no send quota.
        const controls = Array.from({ length: 21 }, (_, sequence) => createAck(sequence));
        for (const control of controls) {
            await fixture.manager.handoffControlMessages([control]);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.channels.b!.sent.map((message) => message.id.msgId)).toEqual(
            controls.map((control) => control.id.msgId)
        );

        for (let sequence = 0; sequence < 20; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast(`own-${sequence}`));
            expect(result.verdict.kind, result.reason).toBe('admitted');
        }
        const refused = createOriginReceiverMulticast('own-20');
        expect((await fixture.manager.enqueueIfAbsent(refused)).verdict)
            .toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(refused.id.msgId)).toBe(false);
        expect(fixture.diagnostics.filter((event) => event.kind === 'rtc-handoff-refusal')).toEqual([
            { kind: 'rtc-handoff-refusal', reason: 'rate-limited', messageCount: 1 }
        ]);

        // The existing 1,000 ms limiter retains an overlapping 250 ms bucket at its edge.
        vi.setSystemTime(Date.now() + 1_251);
        const recovered = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast('own-21'));
        expect(recovered.verdict.kind, recovered.reason).toBe('admitted');
    });

    it('recovers own-send quota on its own clock while preserving independent admission time and the creation millisecond', async () => {
        const quotaStartMs = 1791883286866;
        let quotaAtMs = quotaStartMs;
        let admissionAtMs = quotaStartMs + 20_000;
        vi.setSystemTime(admissionAtMs);
        const creationInstant = Temporal.Instant.from('2026-10-13T23:59:59.123456789Z');
        const creationNow = vi.fn(() => creationInstant);
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            creationNow,
            quotaNow: () => quotaAtMs,
            rateLimiter: RateLimiter.initWithTs(1_000, 20, quotaStartMs)
        });
        vi.spyOn(fixture.resources.clock, 'nowMs').mockImplementation(() => admissionAtMs);

        for (let sequence = 0; sequence < 20; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast(`own-${sequence}`));
            expect(result.verdict.kind, result.reason).toBe('admitted');
            if (sequence === 0) {
                expect(result.entry?.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123');
                expect(result.entry?.audit.date.toString()).toBe('23:59:59.123');
            }
        }
        await vi.advanceTimersByTimeAsync(0);
        creationNow.mockImplementation(() => {
            throw new Error('Creation clock must not be observed during quota refusal');
        });
        const waiting = createOriginReceiverMulticast('own-waiting');
        admissionAtMs += 10_000;
        quotaAtMs = quotaStartMs + 1250;
        expect((await fixture.manager.enqueueIfAbsent(waiting)).verdict)
            .toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(waiting.id.msgId)).toBe(false);

        quotaAtMs = quotaStartMs + 1251;
        creationNow.mockImplementation(() => creationInstant);
        const recovered = await fixture.manager.enqueueIfAbsent(waiting);
        expect(recovered.verdict.kind, recovered.reason).toBe('admitted');
    });

    it('keeps real enqueue failures across neutral quota refusals and recovers through half-open', async () => {
        const circuitBreaker = toCircuitBreaker(1);
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker
        });
        for (let sequence = 0; sequence < 19; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast(`own-${sequence}`));
            expect(result.verdict.kind, result.reason).toBe('admitted');
        }

        vi.spyOn(fixture.resources.admissionStore, 'readOutgoingDecision')
            .mockRejectedValueOnce(new Error('test admission-store failure'));
        const firstFailure = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast('own-19'));
        expect(firstFailure.verdict.kind).toBe('failed');

        for (const sequence of [20, 21]) {
            const message = createOriginReceiverMulticast(`own-${sequence}`);
            const refused = await fixture.manager.enqueueIfAbsent(message);
            expect(refused.verdict).toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        }
        expect(circuitBreaker.isClosed()).toBe(true);

        vi.setSystemTime(Date.now() + 1_251);
        vi.spyOn(fixture.resources.admissionStore, 'readOutgoingDecision')
            .mockRejectedValueOnce(new Error('second test admission-store failure'));
        const secondFailure = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast('own-22'));
        expect(secondFailure.verdict.kind).toBe('failed');
        expect(circuitBreaker.isOpen()).toBe(true);

        const suppressed = createOriginReceiverMulticast('own-23');
        expect((await fixture.manager.enqueueIfAbsent(suppressed)).verdict)
            .toMatchObject({ kind: 'unroutable', reason: 'circuit-open' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(suppressed.id.msgId)).toBe(false);

        vi.setSystemTime(Date.now() + 10_001);
        const recovered = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast('own-24'));
        expect(recovered.verdict.kind, recovered.reason).toBe('admitted');
        expect(circuitBreaker.isClosed()).toBe(true);
    });

    it('states one refusal per hand-off the limiter or the open breaker refuses, with its reason and message count', async () => {
        const circuitBreaker = toCircuitBreaker();
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker
        });
        const readRefusals = () => fixture.diagnostics.filter((event) => event.kind === 'rtc-handoff-refusal');
        for (let sequence = 0; sequence < 20; sequence++) {
            await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast(`own-${sequence}`));
        }
        expect(readRefusals()).toEqual([]);

        const ownBatch = ['own-20', 'own-21', 'own-22'].map(createOriginReceiverMulticast);
        for (const result of await fixture.manager.enqueueAllIfAbsent(ownBatch)) {
            expect(result.verdict).toMatchObject({ kind: 'unroutable', reason: 'rate-limited' });
        }
        circuitBreaker.failureCount(11);
        const controls = [createAck(100), createAck(101)];
        await expect(fixture.manager.handoffControlMessages(controls)).rejects.toThrow('RTC enqueue circuit breaker open');
        for (const control of controls) {
            expect(await fixture.resources.admissionStore.hasSentMessageAdmission(control.id.msgId)).toBe(false);
        }

        expect(readRefusals()).toEqual([
            { kind: 'rtc-handoff-refusal', reason: 'rate-limited', messageCount: 3 },
            { kind: 'rtc-handoff-refusal', reason: 'circuit-open', messageCount: 2 }
        ]);
    });

    it('reports circuit-open first when both protections refuse an own send', async () => {
        const circuitBreaker = toCircuitBreaker();
        const quotaNow = vi.fn(() => Date.now());
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker,
            quotaNow
        });
        for (let sequence = 0; sequence < 20; sequence++) {
            const result = await fixture.manager.enqueueIfAbsent(createOriginReceiverMulticast(`own-${sequence}`));
            expect(result.verdict.kind, result.reason).toBe('admitted');
        }
        circuitBreaker.failureCount(11);
        expect(circuitBreaker.isOpen()).toBe(true);

        quotaNow.mockImplementation(() => {
            throw new Error('Open circuit must refuse before observing quota time');
        });
        const suppressed = createOriginReceiverMulticast('own-20');
        expect((await fixture.manager.enqueueIfAbsent(suppressed)).verdict)
            .toMatchObject({ kind: 'unroutable', reason: 'circuit-open' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(suppressed.id.msgId)).toBe(false);
    });

    it('reports disposal before the open circuit without observing either creation or quota time', async () => {
        const circuitBreaker = toCircuitBreaker();
        circuitBreaker.failureCount(11);
        const quotaNow = () => {
            throw new Error('Disposed carrier must refuse before observing quota time');
        };
        const creationNow = () => {
            throw new Error('Disposed carrier must refuse before observing creation time');
        };
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            circuitBreaker,
            quotaNow,
            creationNow
        });
        await fixture.manager.dispose();

        const message = createOriginReceiverMulticast('own-disposed');
        const result = await fixture.manager.enqueueIfAbsent(message);

        expect(result.verdict).toMatchObject({ kind: 'skipped', reason: 'disposed' });
        expect(await fixture.resources.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        await expect(fixture.manager.handoffControlMessages([createAck(400)])).rejects.toBeInstanceOf(NonRetryableException);
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
