import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { MockedFunction } from 'vitest';
import type { GroupStateSnapshotsRepository } from './auth-session-contract-modules.ts';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

export interface GroupSnapshotRepositoryMocks {
    readonly findFirstGroupStateSnapshotRefSessionIdIsIn: MockedFunction<GroupStateSnapshotsRepository['findFirstGroupStateSnapshotRefSessionIdIsIn']>;
    readonly findGroupStateSnapshotByRef: MockedFunction<GroupStateSnapshotsRepository['findGroupStateSnapshotByRef']>;
    readonly getAllGroupStateSnapshots: MockedFunction<GroupStateSnapshotsRepository['getAllGroupStateSnapshots']>;
}

export function installGroupSnapshotRepositoryMocks(
    mocks: GroupSnapshotRepositoryMocks,
    snapshots: readonly GroupSnapshot[]
): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find(
            (snapshot) =>
                snapshot.group.groupId === ref.groupId &&
                snapshot.group.applicationId === ref.applicationId &&
                (snapshot.group.workspaceId ?? '') === (ref.workspaceId ?? '')
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
        (sessionId) => snapshots.find((snapshot) => snapshot.group.groupId === sessionId)?.group
    );
}

export function createAuthSessionGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[]
): GroupSnapshot {
    return createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        sessionIds
    });
}

export function createAuthSessionApiHttpError(
    status: number,
    message: string
): ApiHttpError {
    return new ApiHttpError(
        'POST',
        '/api/auth/test/requests/test-request-id',
        status,
        JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: `test-${status}`,
            status,
            message,
            issues: null,
            denial: null,
            retry: status === 503
                ? {
                    retryable: true,
                    retryAfterMs: null,
                    reason: 'test-retry'
                }
                : null
        })
    );
}
