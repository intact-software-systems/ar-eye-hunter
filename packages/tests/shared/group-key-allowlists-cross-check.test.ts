import { describe, expect, it } from 'vitest';

import { validatePersistedGroupPresenceSession } from '@shared-server/rallar-system/group-state/persistence/validate-persisted-group-presence.ts';
import { validatePersistedGroup } from '@shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { createTestGroup } from '../create-test-group.ts';
import {
    createDeltaEnvelopeFixture,
    createDeltaEnvelopeFixtureGroupSnapshot
} from '../shared-server/rallar-system/group-state/presence/group-state-delta-envelope-fixtures.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { RFC_7517_PRIVATE_D, RFC_7517_PUBLICATION_KEY } from './api/group-presence/group-presence-publication-key-fixtures.ts';

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
        expect(() => validatePersistedGroup(group, ref)).not.toThrow();
    });

    it('rejects an unregistered member policy key in every list', () => {
        const group = JSON.parse(JSON.stringify(createTestGroup(ref)));
        group.memberPolicy.retries = 3;
        expect(() => validatePersistedGroup(group, ref))
            .toThrow('Stored group memberPolicy has unexpected key: retries');
        const snapshot = JSON.parse(JSON.stringify(createGroupSnapshotFixture({ ...ref, sessionIds: ['alice'] })));
        snapshot.group.memberPolicy.retries = 3;
        expect(() => validateAuthoritativeGroupSnapshot(snapshot, ref))
            .toThrow('GroupSnapshot.group.memberPolicy has unexpected retries');
        const envelope = JSON.parse(JSON.stringify(createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session'] })));
        envelope.group.memberPolicy.retries = 3;
        expect(() => validateGroupStateDeltaEnvelope(envelope))
            .toThrow('memberPolicy has unexpected retries');
    });

    it('rejects a group missing a registered key in every list', () => {
        const { transportState: omitted, ...withoutTransport } = JSON.parse(
            JSON.stringify(createTestGroup(ref))
        );
        expect(omitted).toBe('flowing');
        expect(() => validatePersistedGroup(withoutTransport, ref))
            .toThrow('missing mandatory key: transportState');
    });
});

// The presence session's one key list, GROUP_PRESENCE_SESSION_KEYS, serves the stored row, the snapshot and the
// delta. A compile-complete session with a publication key passes all three; an absent key or a JWK carrying the
// private member `d` fails all three, so no validator reads absence as `null` or admits a private key.
describe('presence session key allowlist against keyof GroupPresenceSession', () => {
    type SessionEdit = (session: GroupPresenceSession) => object;

    function toValidatorFailures(edit: SessionEdit): readonly string[] {
        const snapshot = createDeltaEnvelopeFixtureGroupSnapshot();
        const envelope = createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session'] });
        const ref = snapshot.group;
        const sessions = snapshot.activeSessions.map(edit);
        return [
            () => validatePersistedGroupPresenceSession(sessions[0], ref),
            () => validateAuthoritativeGroupSnapshot({ ...snapshot, activeSessions: sessions }, ref),
            () => validateGroupStateDeltaEnvelope({ ...envelope, sessions })
        ].flatMap((validate) => {
            try {
                validate();
                return [];
            }
            catch (error) {
                return [String((error as Error).message)];
            }
        });
    }

    it('accepts a session that registered a publication key through all three validators', () => {
        expect(toValidatorFailures((session) => ({ ...session, publicationKey: RFC_7517_PUBLICATION_KEY }))).toEqual([]);
    });

    it('accepts a session that registered no key through all three validators', () => {
        expect(toValidatorFailures((session) => session)).toEqual([]);
    });

    it('rejects a session without publicationKey in every validator', () => {
        const failures = toValidatorFailures(({ publicationKey: _omitted, ...session }) => session);
        expect(failures).toHaveLength(3);
        for (const failure of failures) {
            expect(failure).toMatch(/publicationKey/);
        }
    });

    it('rejects a publication key carrying the private member d in every validator', () => {
        const failures = toValidatorFailures((session) => ({
            ...session,
            publicationKey: {
                ...RFC_7517_PUBLICATION_KEY,
                publicJwk: { ...RFC_7517_PUBLICATION_KEY.publicJwk, d: RFC_7517_PRIVATE_D }
            }
        }));
        expect(failures).toHaveLength(3);
        for (const failure of failures) {
            expect(failure).toMatch(/publicationKey is invalid: .*publicJwk\.d/);
        }
    });
});
