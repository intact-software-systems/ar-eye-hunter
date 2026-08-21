import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

describe('authoritative group causal invariants', () => {
    it('requires group snapshotVersion to equal causal groupRevision', () => {
        const snapshot = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            sessionIds: []
        });

        expect(() => validateAuthoritativeGroupSnapshot(snapshot)).not.toThrow();
        expect(() =>
            validateAuthoritativeGroupSnapshot({
                ...snapshot,
                group: { ...snapshot.group, snapshotVersion: 2 }
            })
        ).toThrow(/snapshotVersion.*causalRevision/u);
    });
});
