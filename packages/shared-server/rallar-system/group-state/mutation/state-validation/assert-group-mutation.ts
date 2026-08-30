import { jsonEquals } from '@shared/repository/state-utils.ts';

import { requireJsonSafe } from '../../group-state-validation-primitives.ts';
import { validatePresenceAdmission } from '../../persistence/validate-persisted-group-presence.ts';
import { assertGroupMutationAuthority } from '../command-validation/assert-group-mutation-authority.ts';
import { validateGroupMutationCommand } from '../command-validation/validate-group-mutation-command.ts';
import { computeGroupMutation } from '../orchestration/compute-group-mutation.ts';
import { validateComputedGroupMutationOutbox } from '../result-validation/validate-computed-group-mutation-outbox.ts';
import {
    validateComputedGroupMutation,
    type ValidateComputedGroupMutationInput
} from '../result-validation/validate-computed-group-mutation.ts';
import { validateComputedRosterFacts } from './validate-computed-roster-facts.ts';
import { validateGroupMutationFacts } from './validate-group-mutation-facts.ts';
import { validateGroupMutationRead } from './validate-group-mutation-read.ts';

export function assertGroupMutation(
    input: ValidateComputedGroupMutationInput
): void {
    validateGroupMutationCommand(input.command);
    validateGroupMutationRead(input.read, input.command);
    validateGroupMutationFacts(input.facts);
    assertGroupMutationAuthority(input.command, input.facts);
    requireJsonSafe(
        input.computed.outcome === 'write' ? { ...input.computed, outboxEntries: [] } : input.computed,
        'Group mutation computed result'
    );
    validateComputedGroupMutation(input);
    const canonical = computeGroupMutation({
        command: input.command,
        read: input.read,
        facts: input.facts
    });
    if (!jsonEquals(input.computed, canonical)) {
        throw new TypeError(
            `Group ${input.command.operation} mutation differs from its canonical ` +
                'deterministic projection'
        );
    }
    if (input.computed.outcome === 'idempotency-conflict') {
        return;
    }
    const receipt = input.computed.receipt;
    if (receipt.commandHash !== input.facts.commandHash) {
        throw new TypeError('Group mutation receipt hash differs from facts');
    }
    assertGroupMutationWriteEffects(input);
}

function assertGroupMutationWriteEffects(input: ValidateComputedGroupMutationInput): void {
    if (input.computed.outcome !== 'write') {
        return;
    }
    const receipt = input.computed.receipt;
    validateComputedRosterFacts(input.read, input.computed);
    if (input.computed.presenceAdmission) {
        validatePresenceAdmission(input.computed.presenceAdmission.value);
    }
    validateComputedGroupMutationOutbox({
        command: input.command,
        read: input.read,
        facts: input.facts,
        computed: input.computed
    });
    if (input.computed.event.eventId !== receipt.eventId) {
        throw new TypeError('Group mutation receipt event differs from write event');
    }
    if (input.computed.guard.kind === 'presence' && input.computed.members.length > 0) {
        throw new TypeError('Presence mutation must not write group members');
    }
}
