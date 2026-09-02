import { describe, expect, it } from 'vitest';

import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';

import { emptyRead, principalCommand, requireWrite } from './client-mutation-compute-test-fixtures.ts';

describe('client mutation outbox persistence', () => {
    it('computes SQL timestamps and keeps receipt identities aligned with both entries', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));

        expect(computed.outboxWrites).toHaveLength(2);
        for (const write of computed.outboxWrites) {
            expect(write).toMatchObject({
                systemDate: '1970-01-01',
                createdAt: '1970-01-01T00:00:01Z',
                expiresAt: '1970-01-01T00:00:20Z',
                startedAt: null,
                finishedAt: null,
                nextAt: null,
                attempts: 0
            });
            expect(computed.receipt.outboxIds).toContain(write.entry.key.resourceId);
        }
        expect(() => validateClientMutation({ command, read, computed })).not.toThrow();
    });

    it.each(['systemDate', 'createdAt', 'expiresAt', 'nextAt'] as const)(
        'rejects a changed %s without replacing the computed candidate',
        async (field) => {
            const command = await principalCommand();
            const read = emptyRead(command);
            const computed = requireWrite(computeClientMutation({ command, read }));
            const candidate = {
                ...computed,
                outboxWrites: computed.outboxWrites.map((write) => ({ ...write, [field]: 'forged' }))
            };

            expect(() => validateClientMutation({ command, read, computed: candidate })).toThrow(
                ClientMutationRejectedError
            );
            expect(candidate.outboxWrites[0][field]).toBe('forged');
        }
    );

    it('rejects a persistence accessor without calling it', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));
        let getterCalls = 0;
        const first = Object.defineProperty({ ...computed.outboxWrites[0] }, 'createdAt', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return '1970-01-01T00:00:01Z';
            }
        });
        const candidate = { ...computed, outboxWrites: [first, ...computed.outboxWrites.slice(1)] };

        expect(() => validateClientMutation({ command, read, computed: candidate })).toThrow(
            ClientMutationRejectedError
        );
        expect(getterCalls).toBe(0);
    });

    it.each([false, true])('rejects inherited receipt array accessors without invoking them (throws=%s)', async (throws) => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const computed = requireWrite(computeClientMutation({ command, read }));
        let getterCalls = 0;
        const prototype = Object.create(Array.prototype, {
            forEach: {
                get: () => {
                    getterCalls += 1;
                    if (throws) {
                        throw new RangeError('Inherited accessor must not execute');
                    }
                    return Array.prototype.forEach;
                }
            }
        });
        const candidate = {
            ...computed,
            receipt: { ...computed.receipt, outboxIds: Object.setPrototypeOf([...computed.receipt.outboxIds], prototype) }
        };

        expect(() => validateClientMutation({ command, read, computed: candidate })).toThrow(ClientMutationRejectedError);
        expect(getterCalls).toBe(0);
    });

    for (const field of ['outboxWrites', 'receipt', 'outboxIds'] as const) {
        for (const throws of [false, true]) {
            it(`rejects enclosing ${field} accessor without invoking it (throws=${throws})`, async () => {
                const command = await principalCommand();
                const read = emptyRead(command);
                const computed = requireWrite(computeClientMutation({ command, read }));
                let getterCalls = 0;
                const candidate = { ...computed, receipt: { ...computed.receipt } };
                const value = field === 'outboxIds' ? computed.receipt.outboxIds : computed[field];
                Object.defineProperty(field === 'outboxIds' ? candidate.receipt : candidate, field, {
                    enumerable: true,
                    get: () => {
                        getterCalls += 1;
                        if (throws) {
                            throw new RangeError('Candidate accessor must not execute');
                        }
                        return value;
                    }
                });

                expect(() => validateClientMutation({ command, read, computed: candidate })).toThrow(
                    ClientMutationRejectedError
                );
                expect(getterCalls).toBe(0);
            });
        }
    }
});
