import { computeCrdtMutation } from './compute-crdt-mutation.ts';
import { decodeCrdtMutationCommand } from './crdt-mutation-command-codec.ts';
import type {
    CrdtMutationAttemptFacts,
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationRead,
    CrdtMutationRepository,
    CrdtMutationValidationIssue,
    ValidateCrdtMutationInput
} from './crdt-mutation-contracts.ts';
import { validateCrdtMutation } from './validate-crdt-mutation.ts';

export interface CrdtMutationService {
    read(command: CrdtMutationCommand): Promise<CrdtMutationRead>;
    compute(facts: CrdtMutationAttemptFacts): CrdtMutationComputed;
    validate(
        input: Omit<ValidateCrdtMutationInput, 'serviceId'>
    ): readonly CrdtMutationValidationIssue[];
}

export interface CrdtMutationServiceDependencies {
    readonly repository: CrdtMutationRepository;
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
        validate: (input) => validateCrdtMutation({
            ...input,
            serviceId: dependencies.serviceId
        })
    };
}
