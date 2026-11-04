import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { signALPublicationProof } from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import type {
    GroupPublicationGrant,
    GroupPublicationTopicPermissions
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';

import { createAuditStampFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import type { AvailablePublicationCrypto } from '../signature/publication-crypto-fixtures.ts';
import { createOriginSnapshot, ORIGIN_ROOM } from './rtc-origin-overlay-fixture.ts';

export const PUBLICATION_TOPIC_ID = 'room.granted-feed';

export const PUBLISH_AND_SUBSCRIBE: GroupPublicationTopicPermissions = { publish: true, subscribe: true };
export const PUBLISH_ONLY: GroupPublicationTopicPermissions = { publish: true, subscribe: false };
export const SUBSCRIBE_ONLY: GroupPublicationTopicPermissions = { publish: false, subscribe: true };

export interface PublicationRoomInput {
    readonly sessionIds: readonly string[];
    readonly snapshotVersion: number;
    /** Each session's registered page key; a session absent here registered none. */
    readonly keys: Readonly<Record<string, GroupPresencePublicationKey>>;
    /** Each principal's permissions on the granted topic; a principal absent here holds no grant row. */
    readonly grants: Readonly<Record<string, GroupPublicationTopicPermissions>>;
}

/** The origin room where every session is its own principal, with the keys and grant rows the input names. */
export function createPublicationRoomSnapshot(input: PublicationRoomInput): GroupSnapshot {
    const snapshot = createOriginSnapshot(input.sessionIds, input.snapshotVersion);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            publicationKey: input.keys[session.sessionId] ?? null
        })),
        publicationGrants: Object.keys(input.grants).sort().map((principalId) => toPublicationGrant(principalId, input.grants[principalId]!))
    };
}

/** The room multicast an origin `senderId` admits: frozen to `recipientPeerIds` at `snapshotVersion`, expiry bound. */
export function createFrozenGrantedMulticast(input: FrozenGrantedMulticastInput): ALMessage {
    const message = newALMulticastMessage(
        input.senderId,
        { topicId: PUBLICATION_TOPIC_ID, resourceId: input.resourceId, contextId: ORIGIN_ROOM.groupId },
        ORIGIN_ROOM,
        'room.granted-feed.v1',
        { text: input.text ?? `feed ${input.resourceId}` },
        { ack: 'none', reliability: 'best-effort', ttlMs: 30_000, traceId: `trace-${input.resourceId}` }
    );
    return {
        ...message,
        targets: {
            mode: 'multicast',
            groupRef: ORIGIN_ROOM,
            recipientPeerIds: input.recipientPeerIds,
            snapshotVersion: input.snapshotVersion
        },
        constraints: { ...message.constraints, expiresAtMs: message.id.ts + 30_000 }
    };
}

export interface FrozenGrantedMulticastInput {
    readonly senderId: string;
    readonly resourceId: string;
    readonly recipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
    readonly text?: string;
}

export async function signPublication(crypto: AvailablePublicationCrypto, message: ALMessage): Promise<ALMessage> {
    return (await signALPublicationProof({ subtle: crypto.subtle, keyPair: crypto.keyPair, message })).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (signed) => signed
    );
}

function toPublicationGrant(principalId: string, topic: GroupPublicationTopicPermissions): GroupPublicationGrant {
    return {
        ...ORIGIN_ROOM,
        principalId,
        topics: { [PUBLICATION_TOPIC_ID]: topic },
        updated: createAuditStampFixture(1, 'creator')
    };
}
