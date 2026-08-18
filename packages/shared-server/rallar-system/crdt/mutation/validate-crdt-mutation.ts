import { decodeCrdtMutationResult } from './decode-crdt-mutation-result.ts';
import type {
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationValidationIssue,
  CrdtMutationRead,
  ValidateCrdtMutationInput,
} from './crdt-mutation-contracts.ts';

interface UntrustedCrdtRecord {
  readonly [key: string]: object | string | number | boolean | null | undefined;
}

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
    const result = toRecord(computed.result);
    const resultSnapshot =
      result?.operation === 'compact' &&
      result.status === 'accepted' &&
      typeof result.snapshot === 'object'
        ? result.snapshot
        : null;
    if (
      readSnapshotReason(computed.snapshot) !== command.reason ||
      result?.operation !== 'compact' ||
      result.status !== 'accepted' ||
      readSnapshotReason(resultSnapshot) !== command.reason
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

function readSnapshotReason(snapshot: object | null | undefined): string | null {
  const snapshotRecord = toRecord(snapshot);
  const metadata =
    snapshotRecord && typeof snapshotRecord.metadata === 'object'
      ? toRecord(snapshotRecord.metadata)
      : null;
  return typeof metadata?.reason === 'string' ? metadata.reason : null;
}

function toRecord(value: object | null | undefined): UntrustedCrdtRecord | null {
  return typeof value === 'object' && value !== null ? (value as UntrustedCrdtRecord) : null;
}
