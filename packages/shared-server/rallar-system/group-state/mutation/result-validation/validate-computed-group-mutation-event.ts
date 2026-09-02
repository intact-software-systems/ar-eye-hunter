import { validateAuthoritativeGroupEventIssues } from '@shared/api/authoritative-state-validation.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import { validateGroupStateEventWrite } from '../../../state-events/group-state-event-store.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';

import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';

export function validateComputedGroupMutationEvent({
    command,
    facts,
    computed
}: ValidateComputedGroupMutationWriteInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(
        ...validateAuthoritativeGroupEventIssues(computed.event, command.aggregateRef)
            .map((issue) => toGroupStateValidationIssue(issue.path, issue.message))
    );
    if (issues.length === 0) {
        issues.push(...validateGroupStateEventWrite(computed.event, computed.eventWrite));
    }
    if (!isGroupStateRecord(computed.event) || !isGroupStateRecord(computed.event.actor)) {
        return issues;
    }
    if (
        computed.event.eventId !== facts.eventId ||
        computed.event.occurredAtEpochMs !== facts.nowEpochMs ||
        (computed.event.requestId ?? null) !== command.requestId ||
        actorPrincipalId(computed.event.actor) !== command.input.actorPrincipalId ||
        actorSessionId(computed.event.actor) !== command.input.actorSessionId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.event',
                'Group mutation computed event identity differs from command and facts'
            )
        );
    }
    return issues;
}

function actorPrincipalId(actor: MutationActor): string | null {
    return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
    return actor.kind === 'session' ? actor.sessionId : null;
}

