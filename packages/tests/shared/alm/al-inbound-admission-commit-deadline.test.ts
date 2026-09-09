import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it.each(['entry', 'observation', 'mutation'] as const)('uses original D after awaited %s in first admission and pending replay', async (stage) => {
    for (const replay of [false, true]) {
        for (const offset of [-1, 0, 1]) {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(1_800_000_000_000);
            const state = createInMemoryALAdmissionState();
            const backend = new InMemoryAdmissionBackend(state, Date.now);
            const store = createALInboundAdmissionStore({
                namespace: 'deadline',
                backend,
                orderingTrackTtlMs: 60_000,
                supersedenceTrackTtlMs: 60_000,
                retention: normalizeALRuntimeStoreRetention()
            });
            const planner: ALInboundMessageRuntime.Dependencies['planIncomingMessage'] = (msg, source, observations) =>
                planALMessageHandling(msg, {
                    ...observations,
                    selfPeerId: 'receiver',
                    fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId
                });
            const admission = new ALInboundMessageAdmission({
                admissionStore: store,
                workPort: createTestALInboundWorkPort({
                    admissionStore: store,
                    workQueue: state.workQueue,
                    nowMs: Date.now
                }),
                clock: { nowMs: Date.now },
                effectPreparation: {
                    newControlId: crypto.randomUUID.bind(crypto),
                    selfPeerId: 'receiver',
                    createInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'INBOX')
                },
                planIncomingMessage: planner,
                forwardMessage: undefined,
                canForwardMessage: undefined
            });
            const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'deadline', contextId: 'room' }, 'receiver', 'chat', {}, {
                ttlMs: 1_000,
                qos: { ack: { algo: 'hop' } }
            });
            const deadline = message.constraints!.expiresAtMs!;
            const write = backend.write.bind(backend);
            vi.spyOn(backend, 'write').mockImplementation((operation) =>
                write(async (tx) => {
                    if (stage === 'entry') {
                        vi.setSystemTime(deadline + offset);
                    }
                    const read = tx.read.bind(tx);
                    const set = tx.set.bind(tx);
                    return await operation({
                        ...tx,
                        read: async (key, decode) => {
                            const value = await read(key, decode);
                            if (stage === 'observation') {
                                vi.setSystemTime(deadline + offset);
                            }
                            return value;
                        },
                        set: async (key, value, expiry) => {
                            await set(key, value, expiry);
                            if (stage === 'mutation') {
                                vi.setSystemTime(deadline + offset);
                            }
                        },
                        list: tx.list.bind(tx),
                        remove: tx.remove.bind(tx),
                        readWork: tx.readWork.bind(tx),
                        writeWork: tx.writeWork.bind(tx)
                    });
                })
            );
            const source = { kind: 'rtc-peer' as const, peerId: 'sender' };
            if (replay) {
                expect(await admission.replay({ kind: 'admit-message', msg: message, source })).toBe('completed');
            }
            else {
                const outcome = await admission.attempt(message, source, planner);
                expect(outcome.right).toEqual({
                    kind: 'completed',
                    acceptance: offset < 0 ? { kind: 'admitted' } : { kind: 'not-admitted', reason: 'expired' }
                });
            }
            expect(state.data.size > 0).toBe(offset < 0);
            expect((await backend.workQueue.getAllKeys()).length > 0).toBe(offset < 0);
            admission.dispose();
        }
    }
});
