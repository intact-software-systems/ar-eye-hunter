import { jsonEquals } from '@shared/repository/state-utils.ts';

import type {
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationRead,
} from './group-mutation-contracts.ts';
import { validateGroupMutationCommand } from './validate-group-mutation-command.ts';
import { validateGroupMutationRead } from './validate-group-mutation-read.ts';
import {
  computeGroupMutation,
  validateFacts,
  validateTrustedAuthorityMode,
} from './compute-group-mutation.ts';
import {
  validateComputedMutationShape,
  validateComputedOutboxEntries,
  validateComputedRosterFacts,
} from './validate-computed-group-mutation.ts';
import { validatePresenceAdmission } from '../persistence/validate-persisted-group-presence.ts';
import { requireJsonSafe } from '../group-state-validation-primitives.ts';
export function validateGroupMutation(
  input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
    computed: GroupMutationComputed;
  }>,
): void {
  validateGroupMutationCommand(input.command);
  validateGroupMutationRead(input.read, input.command);
  validateFacts(input.facts);
  validateTrustedAuthorityMode(input.command, input.facts);
  requireJsonSafe(
    input.computed.outcome === 'write' ? { ...input.computed, outboxEntries: [] } : input.computed,
    'Group mutation computed result',
  );
  validateComputedMutationShape(input);
  const canonical = computeGroupMutation({
    command: input.command,
    read: input.read,
    facts: input.facts,
  });
  if (!jsonEquals(input.computed, canonical)) {
    throw new TypeError(
      `Group ${input.command.operation} mutation differs from its canonical ` +
        'deterministic projection',
    );
  }
  if (input.computed.outcome === 'idempotency-conflict') return;
  const receipt = input.computed.receipt;
  if (receipt.commandHash !== input.facts.commandHash) {
    throw new TypeError('Group mutation receipt hash differs from facts');
  }
  if (input.computed.outcome === 'write') {
    validateComputedRosterFacts(input.read, input.computed);
    if (input.computed.presenceAdmission) {
      validatePresenceAdmission(input.computed.presenceAdmission.value);
    }
    validateComputedOutboxEntries(input.command, input.facts, input.computed);
    if (input.computed.event.eventId !== receipt.eventId) {
      throw new TypeError('Group mutation receipt event differs from write event');
    }
    if (input.computed.guard.kind === 'presence' && input.computed.members.length > 0) {
      throw new TypeError('Presence mutation must not write group members');
    }
  }
}
