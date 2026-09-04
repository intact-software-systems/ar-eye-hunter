import { jsonEquals } from '@shared/repository/state-utils.ts';

import { requireJsonSafe } from '../../group-state-validation-primitives.ts';
import { validatePresenceAdmission } from '../../persistence/validate-persisted-group-presence.ts';
import { assertGroupMutationAuthority } from '../command-validation/assert-group-mutation-authority.ts';
import { assertGroupMutationCommand } from '../command-validation/assert-group-mutation-command.ts';
import { computeGroupMutation } from '../orchestration/compute-group-mutation.ts';
import { assertComputedGroupMutationOutbox } from '../result-validation/assert-computed-group-mutation-outbox.ts';
import {
    assertComputedGroupMutation,
    type AssertComputedGroupMutationInput
} from '../result-validation/assert-computed-group-mutation.ts';
import { assertComputedRosterFacts } from './assert-computed-roster-facts.ts';
import { assertGroupMutationFacts } from './assert-group-mutation-facts.ts';
import { assertGroupMutationRead } from './assert-group-mutation-read.ts';

export function assertGroupMutation(
    input: AssertComputedGroupMutationInput
): void {
    assertGroupMutationCommand(input.command);
    assertGroupMutationRead(input.read, input.command);
    assertGroupMutationFacts(input.facts);
    assertGroupMutationAuthority(input.command, input.facts);
    requireJsonSafe(
        input.computed.outcome === 'write' ? { ...input.computed, outboxWrites: [] } : input.computed,
        'Group mutation computed result'
    );
    assertComputedGroupMutation(input);
    const canonical = computeGroupMutation({
        command: input.command,
        read: input.read,
        facts: input.facts
    });
    const receivedProjection = input.computed.outcome === 'write'
        ? { ...input.computed, outboxWrites: [] }
        : input.computed;
    const canonicalProjection = canonical.outcome === 'write'
        ? { ...canonical, outboxWrites: [] }
        : canonical;
    if (!jsonEquals(receivedProjection, canonicalProjection)) {
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

function assertGroupMutationWriteEffects(input: AssertComputedGroupMutationInput): void {
    if (input.computed.outcome !== 'write') {
        return;
    }
    const receipt = input.computed.receipt;
    assertComputedRosterFacts(input.read, input.computed);
    if (input.computed.presenceAdmission) {
        validatePresenceAdmission(input.computed.presenceAdmission.value);
    }
    assertComputedGroupMutationOutbox({
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
