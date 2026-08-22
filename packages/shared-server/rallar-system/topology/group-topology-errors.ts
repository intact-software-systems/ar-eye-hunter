import type { GroupTopologyValidationIssue } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export class GroupTopologyValidationError extends Error {
    readonly status = 422;
    readonly code = 'group-topology-validation-failed';
    readonly issues: readonly GroupTopologyValidationIssue[];

    constructor(issues: readonly GroupTopologyValidationIssue[]) {
        super('Group topology validation failed');
        this.issues = issues;
        this.name = 'GroupTopologyValidationError';
    }
}

export class GroupTopologyCommitConflictError extends Error {
    readonly status = 503;
    readonly code = 'group-topology-commit-conflict';
    readonly groupRef: GroupRef;

    constructor(groupRef: GroupRef) {
        super(`RTC topology predecessor changed before the queued commit: ${JSON.stringify(groupRef)}`);
        this.groupRef = groupRef;
        this.name = 'GroupTopologyCommitConflictError';
    }
}

export class GroupTopologyConfigIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'group-topology-config-idempotency-conflict';
    readonly existingCommandHash: string;
    readonly receivedCommandHash: string;

    constructor(existingCommandHash: string, receivedCommandHash: string) {
        super('Topology config requestId was already used for a different mutation');
        this.existingCommandHash = existingCommandHash;
        this.receivedCommandHash = receivedCommandHash;
        this.name = 'GroupTopologyConfigIdempotencyConflictError';
    }
}
