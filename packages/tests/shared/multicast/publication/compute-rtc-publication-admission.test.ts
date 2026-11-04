import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    computeRtcPublicationAdmission,
    type RtcPublicationAdmissionInput,
    type RtcPublicationRefusalCode
} from '@shared/multicast/publication/compute-rtc-publication-admission.ts';

import { ORIGIN_ROOM } from '../rtc-origin-overlay-fixture.ts';
import {
    createFrozenGrantedMulticast,
    createPublicationRoomSnapshot,
    PUBLISH_AND_SUBSCRIBE,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY,
    type PublicationRoomInput
} from '../rtc-publication-proof-fixtures.ts';

const NOW_EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');

const KEYS: Readonly<Record<string, GroupPresencePublicationKey>> = {
    a: toKey('key-a'),
    b: toKey('key-b'),
    r: toKey('key-r')
};

const ROOM: PublicationRoomInput = {
    sessionIds: ['a', 'b', 'r'],
    snapshotVersion: 3,
    keys: KEYS,
    grants: { a: PUBLISH_AND_SUBSCRIBE, b: PUBLISH_AND_SUBSCRIBE }
};

describe('computeRtcPublicationAdmission', () => {
    it.each<[string, Partial<RtcPublicationAdmissionInput>, RtcPublicationRefusalCode]>([
        ['no readable snapshot', { snapshot: null }, 'no-authority'],
        ['an expired group', { snapshot: toGroup(createPublicationRoomSnapshot(ROOM), { expiresAtEpochMs: NOW_EPOCH_MS }) }, 'no-authority'],
        ['an inactive group', { snapshot: toGroup(createPublicationRoomSnapshot(ROOM), { status: 'archived' }) }, 'no-authority'],
        ['no proof', { message: createSignedLookingMulticast({ proof: undefined }) }, 'missing-proof'],
        ['a broadcast', { message: createSignedLookingMulticast({ targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM } }) }, 'unbound-target'],
        ['a multicast frozen at no snapshot version', {
            message: createSignedLookingMulticast({ targets: { mode: 'multicast', groupRef: ORIGIN_ROOM } })
        }, 'unbound-target'],
        ['a forged senderId naming a member whose key differs', {
            message: createSignedLookingMulticast({ senderId: 'b', keyId: 'key-a' })
        }, 'unknown-key'],
        ['a sender whose presence row registered no key', {
            snapshot: createPublicationRoomSnapshot({ ...ROOM, keys: { b: KEYS.b!, r: KEYS.r! } })
        }, 'unknown-key'],
        ['a target frozen at a snapshot newer than this one', {
            message: createSignedLookingMulticast({ snapshotVersion: 4 })
        }, 'authority-ahead'],
        ['a proof the verifier did not verify', { signatureValid: false }, 'invalid-signature'],
        ['a revoked publisher', {
            snapshot: createPublicationRoomSnapshot({ ...ROOM, grants: { a: SUBSCRIBE_ONLY, b: PUBLISH_AND_SUBSCRIBE } })
        }, 'no-publish-grant'],
        ['a publisher demoted to spectator', { snapshot: toSpectator(createPublicationRoomSnapshot(ROOM), 'a') }, 'no-publish-grant']
    ])('refuses %s as %s', (_name, override, code) => {
        const admission = computeRtcPublicationAdmission({ ...toAdmissionInput(), ...override });

        expect(admission.left).toEqual({ code });
    });

    it.each<[string, ALMessage['targets']]>([
        ['a unicast', { mode: 'unicast', toPeerId: 'b' }],
        ['a world broadcast', { mode: 'broadcast', scope: 'world' }]
    ])('refuses %s naming no room as unbound before it reads a snapshot or a proof', (_name, targets) => {
        const admission = computeRtcPublicationAdmission({
            ...toAdmissionInput(),
            snapshot: null,
            message: { ...createSignedLookingMulticast({ proof: undefined }), targets }
        });

        expect(admission.left).toEqual({ code: 'unbound-target' });
    });

    it('refuses a frame on a topic the page does not grant before anything else: only a granted frame may carry a proof', () => {
        const admission = computeRtcPublicationAdmission({
            ...toAdmissionInput(),
            topicGranted: false,
            snapshot: null,
            message: { ...createSignedLookingMulticast(), targets: { mode: 'broadcast', scope: 'world' } }
        });

        expect(admission.left).toEqual({ code: 'proof-on-ungranted-topic' });
    });

    it('fails closed on a null snapshot before it reads anything else of the frame', () => {
        const admission = computeRtcPublicationAdmission({
            ...toAdmissionInput(),
            snapshot: null,
            message: createSignedLookingMulticast({ proof: undefined }),
            signatureValid: false
        });

        expect(admission.left?.code).toBe('no-authority');
    });

    it('delivers to a subscribed receiver whose token is active, and only forwards while its token is pending', () => {
        const input = toAdmissionInput();

        expect(computeRtcPublicationAdmission(input).right).toEqual({ delivery: 'deliver' });
        expect(computeRtcPublicationAdmission({ ...input, ownSubscriptionActive: false }).right).toEqual({
            delivery: 'forward-only'
        });
    });

    it.each<[string, PublicationRoomInput['grants']]>([
        ['an unsubscribed relay', { a: PUBLISH_AND_SUBSCRIBE, b: PUBLISH_AND_SUBSCRIBE }],
        ['a publisher-only relay', { a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_ONLY }]
    ])('only forwards at %s, whatever its own token', (_name, grants) => {
        const admission = computeRtcPublicationAdmission({
            ...toAdmissionInput(),
            snapshot: createPublicationRoomSnapshot({ ...ROOM, grants }),
            selfPrincipalId: 'r'
        });

        expect(admission.right).toEqual({ delivery: 'forward-only' });
    });

    it('decides by a snapshot newer than the frame: its grants, not the ones the origin froze at', () => {
        const message = createSignedLookingMulticast({ snapshotVersion: 3 });
        const newer = { ...ROOM, snapshotVersion: 5 };

        const revoked = computeRtcPublicationAdmission({
            ...toAdmissionInput(),
            message,
            snapshot: createPublicationRoomSnapshot({ ...newer, grants: { b: PUBLISH_AND_SUBSCRIBE } })
        });
        const subscribed = computeRtcPublicationAdmission({
            ...toAdmissionInput(),
            message,
            snapshot: createPublicationRoomSnapshot({ ...newer, grants: { a: PUBLISH_ONLY, r: SUBSCRIBE_ONLY } }),
            selfPrincipalId: 'r'
        });

        expect([revoked.left?.code, subscribed.right]).toEqual(['no-publish-grant', { delivery: 'deliver' }]);
    });

    it('carries no payload resource in any refusal it returns', () => {
        const message = createSignedLookingMulticast({ text: 'secret-resource-text' });
        const refusals = [
            { snapshot: null },
            { signatureValid: false },
            { snapshot: createPublicationRoomSnapshot({ ...ROOM, grants: {} }) }
        ].map((override) => computeRtcPublicationAdmission({ ...toAdmissionInput(), message, ...override }).left);

        expect(refusals.every((refusal) => refusal !== undefined)).toBe(true);
        expect(JSON.stringify(refusals)).not.toContain('secret-resource-text');
    });
});

interface SignedLookingMulticastInput {
    readonly senderId?: string;
    readonly keyId?: string;
    readonly snapshotVersion?: number;
    readonly text?: string;
    readonly proof?: undefined;
    readonly targets?: ALMessage['targets'];
}

/** A frozen room multicast carrying a proof: the admission reads only its keyId, the verifier judges its bytes. */
function createSignedLookingMulticast(input: SignedLookingMulticastInput = {}): ALMessage {
    const senderId = input.senderId ?? 'a';
    const message = createFrozenGrantedMulticast({
        senderId,
        resourceId: 'feed-1',
        recipientPeerIds: ['a', 'b', 'r'],
        snapshotVersion: input.snapshotVersion ?? 3,
        text: input.text
    });
    const proof = { alg: 'ES256' as const, keyId: input.keyId ?? `key-${senderId}`, signature: 'signature' };
    return {
        ...message,
        targets: 'targets' in input ? input.targets : message.targets,
        proof: 'proof' in input ? undefined : proof
    };
}

function toAdmissionInput(): RtcPublicationAdmissionInput {
    return {
        message: createSignedLookingMulticast(),
        topicGranted: true,
        snapshot: createPublicationRoomSnapshot(ROOM),
        selfPrincipalId: 'b',
        signatureValid: true,
        ownSubscriptionActive: true,
        nowEpochMs: NOW_EPOCH_MS
    };
}

function toGroup(snapshot: GroupSnapshot, group: Partial<GroupSnapshot['group']>): GroupSnapshot {
    return { ...snapshot, group: { ...snapshot.group, ...group } as GroupSnapshot['group'] };
}

function toSpectator(snapshot: GroupSnapshot, principalId: string): GroupSnapshot {
    return {
        ...snapshot,
        members: snapshot.members.map((member) => member.principalId === principalId ? { ...member, role: 'spectator' as const } : member)
    };
}

function toKey(keyId: string): GroupPresencePublicationKey {
    return { keyId, publicJwk: { kty: 'EC', crv: 'P-256', x: `${keyId}-x`, y: `${keyId}-y` } };
}
