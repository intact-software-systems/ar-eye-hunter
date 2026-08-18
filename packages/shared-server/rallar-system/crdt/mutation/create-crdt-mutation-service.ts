import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type {
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationAttemptFacts,
  CrdtMutationResult,
  CrdtMutationRead,
  CrdtMutationRepository,
  CrdtMutationValidationIssue,
  ValidateCrdtMutationInput,
} from './crdt-mutation-contracts.ts';
import { decodeCrdtMutationCommand } from './crdt-mutation-command-codec.ts';
import { computeCrdtMutation } from './compute-crdt-mutation.ts';
import { validateCrdtMutation } from './validate-crdt-mutation.ts';

export interface CrdtMutationService {
  readonly read: (command: CrdtMutationCommand) => Promise<CrdtMutationRead>;
  readonly compute: (facts: CrdtMutationAttemptFacts) => CrdtMutationComputed;
  readonly validate: (input: ValidateCrdtMutationInput) => readonly CrdtMutationValidationIssue[];
  readonly write: (
    transaction: PSqlTransactionSql,
    computed: CrdtMutationComputed,
  ) => Promise<CrdtMutationResult>;
}

export interface CrdtMutationServiceDependencies {
  readonly repository: CrdtMutationRepository;
  readonly createWriter: (transaction: PSqlTransactionSql) => CrdtMutationRepository;
  readonly serviceId: string;
}

export function createCrdtMutationService(
  dependencies: CrdtMutationServiceDependencies,
): CrdtMutationService {
  return {
    read: async (command: CrdtMutationCommand) =>
      await dependencies.repository.readMutation(decodeCrdtMutationCommand(command)),
    compute: ({ command, read }: CrdtMutationAttemptFacts) =>
      computeCrdtMutation({ command, read, serviceId: dependencies.serviceId }),
    validate: validateCrdtMutation,
    write: async (transaction: PSqlTransactionSql, computed: CrdtMutationComputed) => {
      const writer = dependencies.createWriter(transaction);
      if (computed.outcome === 'write') {
        await writer.writeMutation(computed);
      }
      await writer.writeOutbox(computed.outboxEntries);
      return computed.result;
    },
  };
}
