import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeTemporaryRoomPolicy } from '@shared/api/room-guests/temporary-room-policy.ts';
import { decodeRoomLobbyPolicy } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { decodeRoomOwnedAppDataBindings, type RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { ApiV1GroupConfiguration } from './api-v1-configuration.ts';
import { computeApiReplicaLimitShare } from './compute-api-replica-limit-share.ts';
import { isApiV1ConfigurationSourceRecord, type ApiV1ConfigurationSourceValue } from './decode-api-v1-configuration-source.ts';
import type { ApiV1ConfigurationValueDecoder } from './decode-api-v1-configuration-values.ts';

function decodeApplicationPolicies<Policy>(
    decoder: ApiV1ConfigurationValueDecoder,
    path: string,
    decodePolicy: (value: ApiV1ConfigurationSourceValue | undefined) => Policy
): Readonly<Record<string, Policy>> {
    try {
        const policies = decoder.sourceValue(path);
        if (!isApiV1ConfigurationSourceRecord(policies)) throw new TypeError('An application policy table is required.');
        return Object.fromEntries(Object.entries(policies).map(([app, policy]) =>
            [assertValidRallarRouteId(app), decodePolicy(policy)]));
    }
    catch (error) {
        decoder.sourceIssue(path, 'invalid-application-policies', error instanceof Error ? error.message : 'Invalid application policy.');
        return {};
    }
}

export function decodeApiV1Group(
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1GroupConfiguration {
    const defaultMaxMembers = decoder.integer('group.defaultMaxMembers', 0);
    return {
        roomLobbyPoliciesByApplication: decodeApplicationPolicies(decoder, 'group.roomLobbyPoliciesByApplication', decodeRoomLobbyPolicy),
        eventHandoverWindowMs: decoder.integer('group.eventHandoverWindowMs', 1),
        eventOrganizerIdsByApplication: decodeApplicationPolicies(decoder, 'group.eventOrganizerIdsByApplication', value => {
            if (!Array.isArray(value) || !value.every(id => typeof id === 'string') || new Set(value).size !== value.length) {
                throw new Error('Event organizer IDs must be a list of distinct principal IDs.');
            }
            return value.map(id => assertValidRallarRouteId(id));
        }),
        guestBookingByApplication: decodeApplicationPolicies(decoder, 'group.guestBookingByApplication', value => {
            if (typeof value !== 'boolean') throw new TypeError('Guest booking app policy must be a boolean.');
            return value;
        }),
        temporaryRoomPoliciesByApplication: decodeApplicationPolicies(decoder, 'group.temporaryRoomPoliciesByApplication', value => {
            const policy = decodeTemporaryRoomPolicy(value);
            return { ...policy, creationLimit: computeApiReplicaLimitShare(policy.creationLimit, decoder.replicaCount()) };
        }),
        defaultMaxMembers: defaultMaxMembers === 0 ? null : defaultMaxMembers,
        currentSnapshotCacheMaxEntries: decoder.integer('group.currentSnapshotCacheMaxEntries', 1),
        roomOwnedAppDataBindings: decodeRoomOwnedBindings(decoder),
        admission: {
            windowMs: decoder.integer('group.admission.windowMs', 1),
            joinPrincipal: decoder.replicaLimitShare('group.admission.joinPrincipal', 1),
            joinGroup: decoder.replicaLimitShare('group.admission.joinGroup', 1),
            presencePrincipal: decoder.replicaLimitShare('group.admission.presencePrincipal', 1),
            presenceGroup: decoder.replicaLimitShare('group.admission.presenceGroup', 1)
        }
    };
}

function decodeRoomOwnedBindings(decoder: ApiV1ConfigurationValueDecoder): readonly RoomOwnedAppData.Binding[] {
    const path = 'group.roomOwnedAppDataBindings';
    try {
        return decodeRoomOwnedAppDataBindings(decoder.sourceValue(path));
    }
    catch {
        decoder.sourceIssue(
            path,
            'invalid-room-owned-catalog',
            'An explicit complete room-owned data binding array is required, with exact identities and unique store ownership.'
        );
        return [];
    }
}
