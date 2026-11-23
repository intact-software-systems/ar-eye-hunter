import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import {
    isALInboundOriginAuthenticated,
    isALInboundOriginAuthenticatedReadmission
} from '@shared/alm/inbound/admission/is-al-inbound-origin-authenticated-readmission.ts';
import type { ALInboundMessageOwner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    decodeALInboundMessageOwner,
    toALInboundMessageOwnerKey,
    toALStoredInboundMessageOwnerRow
} from '@shared/alm/inbound/al-inbound-source-validation.ts';

const ROOM = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' } as const;

const MULTICAST: ALMessage = newALMulticastMessage({
    createdAtEpochMs: 1,
    senderId: 'a',
    route: { topicId: 'chat', resourceId: 'm-1', contextId: 'room' },
    groupRef: ROOM,
    typeId: 'chat.message.v1',
    resource: {}
});

const UNICAST: ALMessage = newALUnicastMessage({
    createdAtEpochMs: 1,
    senderId: 'a',
    route: MULTICAST.route,
    toPeerId: 'c',
    typeId: 'chat.message.v1',
    resource: {},
    options: { groupRef: ROOM }
});

const UNAUTHENTICATED_OWNER: ALInboundMessageOwner = {
    msgId: MULTICAST.id.msgId,
    senderId: 'a',
    source: { kind: 'rtc-peer', peerId: 'b' },
    supersedenceKey: null,
    deliveredLocally: true,
    originAuthenticated: false
};

const AUTHENTICATED_OWNER: ALInboundMessageOwner = { ...UNAUTHENTICATED_OWNER, originAuthenticated: true };

describe('isALInboundOriginAuthenticated', () => {
    it('authenticates a copy the WS server delivered, or one whose proof verified, and no other', () => {
        expect([
            isALInboundOriginAuthenticated({ source: { kind: 'trusted-server' }, proofVerified: false }),
            isALInboundOriginAuthenticated({ source: { kind: 'rtc-peer', peerId: 'a' }, proofVerified: true }),
            isALInboundOriginAuthenticated({ source: { kind: 'rtc-peer', peerId: 'a' }, proofVerified: false })
        ]).toEqual([true, true, false]);
    });
});

describe('isALInboundOriginAuthenticatedReadmission', () => {
    it.each<[string, ALMessage, ALAckAlgo, boolean, ALInboundMessageOwner | undefined, boolean]>([
        ['an authenticated receiver copy over an unauthenticated admission', MULTICAST, 'receiver', true, UNAUTHENTICATED_OWNER, true],
        ['an authenticated leader copy over an unauthenticated admission', MULTICAST, 'leader', true, UNAUTHENTICATED_OWNER, true],
        ['an authenticated hop copy', MULTICAST, 'hop', true, UNAUTHENTICATED_OWNER, false],
        ['an authenticated subtree copy', MULTICAST, 'subtree', true, UNAUTHENTICATED_OWNER, false],
        ['an authenticated unreceipted copy', MULTICAST, 'none', true, UNAUTHENTICATED_OWNER, false],
        ['an unauthenticated receiver copy', MULTICAST, 'receiver', false, UNAUTHENTICATED_OWNER, false],
        ['a copy over an authenticated admission', MULTICAST, 'receiver', true, AUTHENTICATED_OWNER, false],
        ['a copy whose first admission\'s owner row expired', MULTICAST, 'receiver', true, undefined, false],
        ['an authenticated receiver room unicast', UNICAST, 'receiver', true, UNAUTHENTICATED_OWNER, false]
    ])('readmits %s: %s', (_name, msg, ackAlgo, originAuthenticated, owner, readmitted) => {
        expect(isALInboundOriginAuthenticatedReadmission({ msg, ackAlgo, originAuthenticated, owner })).toBe(readmitted);
    });
});

describe('the persisted origin-authentication mark of an inbound owner row', () => {
    const slot = {
        namespace: 'ns',
        key: toALInboundMessageOwnerKey('ns', UNAUTHENTICATED_OWNER.msgId, 'a'),
        expectedMsgId: UNAUTHENTICATED_OWNER.msgId,
        expectedSenderId: 'a'
    };

    it('writes the mark only when the admission was authenticated, and reads a row without it as unauthenticated', () => {
        const unmarked = toALStoredInboundMessageOwnerRow(UNAUTHENTICATED_OWNER);
        const marked = toALStoredInboundMessageOwnerRow(AUTHENTICATED_OWNER);

        expect('originAuthenticated' in unmarked).toBe(false);
        expect(marked.originAuthenticated).toBe(true);
        expect(decodeALInboundMessageOwner(structuredClone(unmarked), slot)).toEqual(UNAUTHENTICATED_OWNER);
        expect(decodeALInboundMessageOwner(structuredClone(marked), slot)).toEqual(AUTHENTICATED_OWNER);
    });

    it('reads an older build\'s row, written before the mark existed, as not authenticated, and refuses a false mark', () => {
        const { originAuthenticated: _mark, deliveredLocally: _delivered, ...olderRow } = UNAUTHENTICATED_OWNER;

        expect(decodeALInboundMessageOwner(olderRow, slot)).toMatchObject({ originAuthenticated: false });
        expect(() => decodeALInboundMessageOwner({ ...olderRow, originAuthenticated: false }, slot)).toThrow(TypeError);
    });
});
