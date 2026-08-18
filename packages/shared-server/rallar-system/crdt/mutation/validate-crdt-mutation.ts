import { decodeCrdtMutationResult } from './decode-crdt-mutation-result.ts';
import type {
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationValidationIssue,
  CrdtMutationRead,
  ValidateCrdtMutationInput,
} from './crdt-mutation-contracts.ts';

export function validateCrdtMutation(
  input: ValidateCrdtMutationInput,
): readonly CrdtMutationValidationIssue[] {
  const { command, read, computed } = input;
  const issues: CrdtMutationValidationIssue[] = [];
  if (
    computed.command !== command ||
    computed.read !== read ||
    computed.commandId !== command.commandId ||
    computed.commandHash !== command.commandHash ||
    computed.documentKey !== command.documentKey
  ) {
    issues.push({
      code: 'computed-identity-differs',
      message: 'CRDT computed identity differs from command',
    });
  }
  if (
    computed.outcome === 'write' &&
    read.document &&
    computed.expectedDocumentRevision !== read.document.documentRevision
  ) {
    issues.push({
      code: 'computed-predecessor-differs',
      message: 'CRDT computed predecessor differs from read document',
    });
  }
  if (command.operation === 'compact' && computed.outcome === 'write') {
    const result = computed.result;
    const resultSnapshot =
      result.operation === 'compact' && result.status === 'accepted' ? result.snapshot : undefined;
    if (
      computed.snapshot?.metadata.reason !== command.reason ||
      result.operation !== 'compact' ||
      result.status !== 'accepted' ||
      resultSnapshot?.metadata?.reason !== command.reason
    ) {
      issues.push({
        code: 'compact-reason-differs',
        message: 'CRDT compact reason differs across command and computed result',
      });
    }
  }
  try {
    decodeCrdtMutationResult(computed.result);
  } catch (error) {
    issues.push({
      code: 'result-codec-invalid',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return issues;
}
