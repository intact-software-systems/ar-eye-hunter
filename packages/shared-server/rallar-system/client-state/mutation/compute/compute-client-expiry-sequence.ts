import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { clientStatePrincipalStorageKey } from '../../persistence/client-state-principal-storage-key.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationRead
} from '../client-mutation-contracts.ts';
import { computeClientMutation } from './compute-client-mutation.ts';

export interface ClientExpiryAttempt {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly mutation: ClientMutationComputed;
}

/** One atomic page can expire several sessions of one principal; later writes use its computed predecessor. */
export function computeClientExpirySequence(
    inputs: readonly Pick<ClientExpiryAttempt, 'command' | 'read'>[]
): readonly ClientExpiryAttempt[] {
    const successors = new Map<
        string,
        { sourceRevision: number; mutation: Extract<ClientMutationComputed, { outcome: 'write'; }>; }
    >();
    return inputs.map((input) => {
        const key = clientStatePrincipalStorageKey(input.command.aggregateRef);
        const previous = successors.get(key);
        let read = input.read;
        if (previous !== undefined) {
            if (read.principal?.entry.revision !== previous.sourceRevision) {
                throw new RuntimeStateWriteConflictError();
            }
            const mutation = previous.mutation;
            if (mutation.principal.operation !== 'update') {
                throw new TypeError('Expiry requires an existing principal predecessor');
            }
            read = {
                ...read,
                principal: {
                    entry: {
                        ...read.principal.entry,
                        value: encodeRuntimeStateJsonValue(mutation.principal.value),
                        revision: mutation.principal.expectedRevision + 1
                    },
                    value: mutation.principal.value
                },
                snapshot: mutation.snapshot
            };
        }
        const mutation = computeClientMutation({ command: input.command, read });
        if (mutation.outcome === 'write') {
            if (input.read.principal === null) {
                throw new TypeError('Expiry requires an existing principal');
            }
            successors.set(key, {
                sourceRevision: previous?.sourceRevision ?? input.read.principal.entry.revision,
                mutation
            });
        }
        return { command: input.command, read, mutation };
    });
}
