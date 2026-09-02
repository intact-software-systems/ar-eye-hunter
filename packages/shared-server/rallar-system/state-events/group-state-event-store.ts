import { validateAuthoritativeGroupEventIssues } from '@shared/api/authoritative-state-validation.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import { validateAppInboxComputedProjection } from '../app-inbox/handler/app-inbox-computed-validation.ts';
import { groupStateEventWorkspaceKey } from './postgres/group-state-event-workspace-key.ts';
import type { StateEventListQuery } from './state-event-listing.ts';

export interface GroupStateEventWrite {
    readonly applicationId: GroupEvent['applicationId'];
    readonly workspaceId: GroupEvent['workspaceId'];
    readonly workspaceKey: string;
    readonly groupId: GroupEvent['groupId'];
    readonly eventId: GroupEvent['eventId'];
    readonly eventType: GroupEvent['eventType'];
    readonly snapshotVersion: GroupEvent['snapshotVersion'];
    readonly occurredAtEpochMs: GroupEvent['occurredAtEpochMs'];
    readonly eventJson: string;
    readonly collision: GroupStateEventCollisionError;
}

export interface GroupStateEventWriteValidationIssue {
    readonly path: string;
    readonly cause: Error;
}

export interface GroupStateEventStore {
    appendGroupEvent(computed: GroupStateEventWrite): Promise<void>;
    readGroupEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined>;
    listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    listRecentGroupEvents(
        ref: GroupRef,
        query?: StateEventListQuery
    ): Promise<readonly GroupEvent[]>;
    listGroupEventPage(
        ref: GroupRef,
        query?: StateEventListQuery
    ): Promise<StateEventPage<GroupEvent>>;
}

export class GroupStateEventRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-state-event-repository-invariant-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'GroupStateEventRepositoryInvariantCorruptionError';
    }
}

export function computeGroupStateEventWrite(event: GroupEvent): GroupStateEventWrite {
    return {
        applicationId: event.applicationId,
        workspaceId: event.workspaceId,
        workspaceKey: groupStateEventWorkspaceKey(event.workspaceId),
        groupId: event.groupId,
        eventId: event.eventId,
        eventType: event.eventType,
        snapshotVersion: event.snapshotVersion,
        occurredAtEpochMs: event.occurredAtEpochMs,
        eventJson: JSON.stringify(event),
        collision: new GroupStateEventCollisionError({
            applicationId: event.applicationId,
            workspaceId: event.workspaceId,
            groupId: event.groupId,
            eventId: event.eventId
        })
    };
}

export function validateGroupStateEventWrite(
    event: GroupEvent,
    computed: GroupStateEventWrite
): readonly GroupStateEventWriteValidationIssue[] {
    const issues = validateAuthoritativeGroupEventIssues(event, event);
    if (issues.length > 0) {
        return issues.map((issue) => ({
            path: issue.path,
            cause: new GroupStateEventRepositoryInvariantCorruptionError(issue.message)
        }));
    }
    let expected: GroupStateEventWrite;
    try {
        expected = computeGroupStateEventWrite(event);
    }
    catch (error) {
        return [{
            path: 'computed.eventWrite',
            cause: new GroupStateEventRepositoryInvariantCorruptionError(
                error instanceof Error ? error.message : 'Group event persistence values cannot be encoded'
            )
        }];
    }
    return validateAppInboxComputedProjection(expected, computed, 'computed.eventWrite');
}

export class GroupStateEventCollisionError extends Error {
    readonly code = 'group-state-event-collision';
    readonly status = 409;

    readonly event: Pick<GroupEvent, 'applicationId' | 'workspaceId' | 'groupId' | 'eventId'>;

    constructor(
        event: Pick<GroupEvent, 'applicationId' | 'workspaceId' | 'groupId' | 'eventId'>
    ) {
        super(`Group state event already exists with divergent content: ${event.eventId}`);
        this.event = event;
        this.name = 'GroupStateEventCollisionError';
    }
}
