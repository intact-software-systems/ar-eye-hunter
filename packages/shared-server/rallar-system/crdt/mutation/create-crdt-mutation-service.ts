import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { computeCrdtMutation } from './compute-crdt-mutation.ts';
import { decodeCrdtMutationCommand } from './crdt-mutation-command-codec.ts';
import type {
    CrdtMutationAttemptFacts,
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationRead,
    CrdtMutationRepository,
    CrdtMutationResult,
    CrdtMutationValidationIssue,
    ValidateCrdtMutationInput
} from './crdt-mutation-contracts.ts';
import { validateCrdtMutation } from './validate-crdt-mutation.ts';

export interface CrdtMutationService {
    read(command: CrdtMutationCommand): Promise<CrdtMutationRead>;
    compute(facts: CrdtMutationAttemptFacts): CrdtMutationComputed;
    validate(input: ValidateCrdtMutationInput): readonly CrdtMutationValidationIssue[];
    write(
        transaction: PSqlSql,
        computed: CrdtMutationComputed
    ): Promise<CrdtMutationResult>;
}

export interface CrdtMutationServiceDependencies {
    readonly repository: CrdtMutationRepository;
    readonly createWriter: (transaction: PSqlSql) => CrdtMutationRepository;
    readonly serviceId: string;
}

export function createCrdtMutationService(
    dependencies: CrdtMutationServiceDependencies
): CrdtMutationService {
    return {
        read: async (command: CrdtMutationCommand) =>
            await dependencies.repository.readMutation(decodeCrdtMutationCommand(command)),
        compute: ({ command, read }: CrdtMutationAttemptFacts) =>
            computeCrdtMutation({ command, read, serviceId: dependencies.serviceId }),
        validate: validateCrdtMutation,
        write: async (transaction: PSqlSql, computed: CrdtMutationComputed) => {
            const writer = dependencies.createWriter(transaction);
            if (computed.outcome === 'write') {
                await writer.writeMutation(computed);
            }
            await writer.writeOutbox(computed.outboxEntries);
            return computed.result;
        }
    };
}
