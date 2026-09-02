import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { ClientStateInboxHandler } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts';
import type { ClientMutationCommand, ClientMutationRead } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutationResult } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-result.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createAtomicHarness } from '../app-inbox/test-support/app-inbox-transaction-test-runtime.ts';
import {
    connectCommand,
    emptyRead,
    heartbeatCommand,
    instanceCommand,
    principalCommand,
    readAfterWrite,
    requireWrite
} from './client-mutation-compute-test-fixtures.ts';

interface ClientRevisionAttempt {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
}

const INVALID_UPDATE_REVISIONS = [
    -1,
    -0,
    0.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1
] as const;

describe('client mutation storage revision boundaries', () => {
    it.each(['instance', 'session'] as const)('rejects an original %s MAX revision in mutation validation', async (target) => {
        const attempt = await createRevisionAttempt(target, Number.MAX_SAFE_INTEGER);
        const computed = requireWrite(computeClientMutation(attempt));

        expect(computed[target]).toMatchObject({ operation: 'update', expectedRevision: Number.MAX_SAFE_INTEGER });
        expect(() => validateClientMutation({ ...attempt, computed })).toThrow(ClientMutationRejectedError);
    });

    it.each(['principal', 'instance', 'session'] as const)('rejects every invalid %s update guard in the result boundary', async (target) => {
        const attempt = await createRevisionAttempt(target === 'session' ? 'session' : 'instance', 0);
        const computed = requireWrite(computeClientMutation(attempt));
        for (const expectedRevision of INVALID_UPDATE_REVISIONS) {
            const malformed = {
                ...computed,
                [target]: { ...computed[target], expectedRevision }
            };

            expect(() => validateClientMutationResult(malformed)).toThrow(ClientMutationRejectedError);
        }
    });

    it.each(['instance', 'session'] as const)('rejects original invalid %s revisions before handler transaction entry', async (target) => {
        for (const revision of INVALID_UPDATE_REVISIONS) {
            const attempt = await createRevisionAttempt(target, revision);
            const atomic = createAtomicHarness();
            const writes: string[] = [];
            const transactionWriter = new AppInboxTransactionWriter({ database: atomic.database.sql }, {
                serviceId: 'client-service',
                nowEpochMs: () => 4_000
            });
            const handler = new ClientStateInboxHandler({
                mutationService: {
                    read: async () => attempt.read,
                    write: async (_transaction, computed) => {
                        writes.push(computed.outcome);
                        return computed.receipt;
                    }
                },
                mutationTiming: { serviceId: 'client-service', sink: undefined },
                sessionGenerationLifecycle: {
                    read: unexpectedWsLifecycle,
                    write: unexpectedWsLifecycle
                },
                expiryCandidates: { listExpiredSessionCandidates: async () => [] },
                snapshotObserver: { observeSnapshot: async (snapshot) => snapshot },
                transactionWriter,
                serviceId: 'client-service'
            });
            const { facts, authority, ...input } = attempt.command;
            const context = {
                ...atomic.context,
                enqueue: {
                    ...atomic.context.enqueue,
                    type: target === 'instance' ? AppInboxType.CLIENT_INSTANCE_UPSERT : AppInboxType.CLIENT_SESSION_HEARTBEAT,
                    authority
                },
                message: { ...atomic.context.message, id: { ...atomic.context.message.id, ts: facts.nowEpochMs } }
            };

            await expect(handler.processCommand(context, input)).rejects.toThrow(ClientMutationRejectedError);
            expect(atomic.database.beginCalls).toBe(0);
            expect(writes).toEqual([]);
            expect(atomic.database.state.results.size).toBe(0);
            expect([...atomic.database.state.inbox.values()].map((entry) => entry.status)).toEqual([EntityStatus.RESERVED]);
        }
    });

    it.each(['instance', 'session'] as const)('accepts zero and the last incrementable %s revision', async (target) => {
        for (const revision of [0, Number.MAX_SAFE_INTEGER - 1]) {
            const attempt = await createRevisionAttempt(target, revision);
            const computed = requireWrite(computeClientMutation(attempt));

            expect(() => validateClientMutation({ ...attempt, computed })).not.toThrow();
            expect(computed[target]).toMatchObject({ operation: 'update', expectedRevision: revision });
        }
    });

    it('retains the stricter principal storage-plus-two domain bound', async () => {
        const seedCommand = await principalCommand();
        const seed = requireWrite(computeClientMutation({ command: seedCommand, read: emptyRead(seedCommand) }));
        const command = await principalCommand('changed-principal', 'Changed');
        const original = readAfterWrite(command, seed);
        if (original.principal === null) {
            throw new Error('Expected original principal');
        }
        for (const revision of [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
            const read = {
                ...original,
                principal: { ...original.principal, entry: { ...original.principal.entry, revision } }
            };
            if (revision === Number.MAX_SAFE_INTEGER - 2) {
                const computed = requireWrite(computeClientMutation({ command, read }));
                expect(() => validateClientMutation({ command, read, computed })).not.toThrow();
                expect(computed.receipt.stateRevision).toBe(Number.MAX_SAFE_INTEGER);
            }
            else {
                expect(() => computeClientMutation({ command, read })).toThrow();
            }
        }
    });

    it('keeps an unchanged instance at MAX as a valid no-op', async () => {
        const command = await instanceCommand();
        const seed = requireWrite(computeClientMutation({ command, read: emptyRead(command) }));
        const original = readAfterWrite(command, seed);
        if (original.instance === null) {
            throw new Error('Expected original instance');
        }
        const read = {
            ...original,
            instance: { ...original.instance, entry: { ...original.instance.entry, revision: Number.MAX_SAFE_INTEGER } }
        };
        const computed = computeClientMutation({ command, read });

        expect(computed.outcome).toBe('no-op');
        expect(() => validateClientMutation({ command, read, computed })).not.toThrow();
    });

    it('keeps a stale-generation heartbeat at MAX as a valid no-op', async () => {
        const attempt = await createRevisionAttempt('session', Number.MAX_SAFE_INTEGER);
        const command = await heartbeatCommand('stale-heartbeat', 'older-generation');
        const computed = computeClientMutation({ command, read: attempt.read });

        expect(computed.outcome).toBe('no-op');
        expect(() => validateClientMutation({ command, read: attempt.read, computed })).not.toThrow();
    });
});

async function createRevisionAttempt(target: 'instance' | 'session', revision: number): Promise<ClientRevisionAttempt> {
    const seedCommand = await connectCommand();
    const seed = requireWrite(computeClientMutation({ command: seedCommand, read: emptyRead(seedCommand) }));
    const command = target === 'instance' ? await instanceCommand() : await heartbeatCommand();
    const original = readAfterWrite(command, seed);
    const current = original[target];
    if (current === null) {
        throw new Error(`Expected original ${target}`);
    }
    return {
        command,
        read: {
            ...original,
            session: target === 'instance' ? null : original.session,
            [target]: { ...current, entry: { ...current.entry, revision } }
        }
    };
}

async function unexpectedWsLifecycle(): Promise<never> {
    throw new Error('Client revision test must not enter WebSocket lifecycle');
}
