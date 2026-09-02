import { describe, expect, it } from 'vitest';

import { validateStoredGroup } from '@shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { createTestGroup } from '../create-test-group.ts';
import { createDeltaEnvelopeFixture } from '../shared-server/rallar-system/group-state/presence/group-state-delta-envelope-fixtures.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

// The aggregate's four key allowlists are hand-maintained and compiler-blind
// (two module-private GROUP_KEYS, STORED_GROUP_KEYS, the OpenAPI required
// block). `createTestGroup` is annotated `Group`, so a new required field is
// a compile error here — and driving that compile-complete group through all
// three validators makes each list's drift a test failure in this file:
// a key missing from a list throws "unexpected key", a stale extra key
// throws "missing mandatory key".
describe('group key allowlists against keyof Group', () => {
    const ref = {
        applicationId: 'allowlist-app',
        workspaceId: 'allowlist-workspace',
        groupId: 'allowlist-group'
    };

    it('accepts a compile-complete group through the authoritative snapshot list', () => {
        const snapshot = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice'] });
        expect(() => validateAuthoritativeGroupSnapshot(snapshot, ref)).not.toThrow();
    });

    it('accepts a compile-complete group through the delta list', () => {
        expect(() =>
            validateGroupStateDeltaEnvelope(
                createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session'] })
            )
        ).not.toThrow();
    });

    it('accepts a compile-complete group through the stored list', () => {
        const group = JSON.parse(JSON.stringify(createTestGroup(ref)));
        expect(validateStoredGroup(group, ref)).toEqual([]);
    });

    it('rejects a group missing a registered key in every list', () => {
        const { transportState: omitted, ...withoutTransport } = JSON.parse(
            JSON.stringify(createTestGroup(ref))
        );
        expect(omitted).toBe('flowing');
        expect(validateStoredGroup(withoutTransport, ref)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                cause: expect.objectContaining({ message: expect.stringContaining('missing mandatory key: transportState') })
            })
        ]));
    });
});
