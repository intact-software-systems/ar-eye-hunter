import { decodeCrdtMutationResult } from './crdt-mutation-codec.ts';
import type {
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationRead,
} from './crdt-mutation-contracts.ts';

export function validateCrdtMutation(
  command: CrdtMutationCommand,
  read: CrdtMutationRead,
  computed: CrdtMutationComputed,
): void {
  if (
    computed.commandId !== command.commandId ||
    computed.commandHash !== command.commandHash ||
    computed.documentKey !== command.documentKey
  ) throw new TypeError('CRDT computed identity differs from command');
  if (
    computed.outcome === 'write' &&
    read.document &&
    computed.expectedDocumentRevision !== read.document.documentRevision
  ) throw new TypeError('CRDT computed predecessor differs from read document');
  if (command.operation === 'compact' && computed.outcome === 'write') {
    const result = computed.result;
    if (
      computed.snapshot?.metadata.reason !== command.reason ||
      result.operation !== 'compact' ||
      result.status !== 'accepted' ||
      result.snapshot.metadata.reason !== command.reason
    ) throw new TypeError('CRDT compact reason differs across command and computed result');
  }
  decodeCrdtMutationResult(computed.result);
}
