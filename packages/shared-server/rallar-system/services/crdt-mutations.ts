import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import type {
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationRead,
    CrdtMutationRepository,
} from './crdt-mutation-contracts.ts';
import { decodeCrdtMutationCommand } from './crdt-mutation-codec.ts';
import { computeCrdtMutation, validateCrdtMutation } from './crdt-mutation-compute.ts';

export * from './crdt-mutation-contracts.ts';
export * from './crdt-mutation-codec.ts';

export type CrdtMutationService = ReturnType<typeof createCrdtMutationService>;

export function createCrdtMutationService(options: Readonly<{
    repository: CrdtMutationRepository;
    createWriter(transaction: PSqlTransactionSql): CrdtMutationRepository;
    serviceId: string;
}>) {
    return {
        read: async (command: CrdtMutationCommand) =>
            await options.repository.readMutation(decodeCrdtMutationCommand(command)),
        compute: (command: CrdtMutationCommand, read: CrdtMutationRead) =>
            computeCrdtMutation(command, read, options.serviceId),
        validate: validateCrdtMutation,
        write: async (transaction: PSqlTransactionSql, computed: CrdtMutationComputed) => {
            const writer = options.createWriter(transaction);
            if (computed.outcome === 'write') await writer.writeMutation(computed);
            await writer.writeOutbox(computed.outboxEntries);
            return computed.result;
        },
    };
}
