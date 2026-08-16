import type {
    ClientEvent,
    ClientPrincipalRef,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import {
    validateAuthoritativeClientEvent,
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupSnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    ComputedClientStateSync,
    ComputedClientStateSyncEffect,
    ComputedGroupStateSync,
    ComputedGroupStateSyncEffect,
} from '../state-sync-publisher.ts';

export function validateComputedStateSyncFacts(
    computed: ComputedClientStateSync | ComputedGroupStateSync,
    senderId: string,
): void {
    if (
        typeof computed !== 'object' ||
        computed === null ||
        typeof computed.commandId !== 'string' ||
        computed.commandId.length === 0 ||
        typeof senderId !== 'string' ||
        senderId.length === 0 ||
        !Number.isSafeInteger(computed.createdAtEpochMs) ||
        !Number.isSafeInteger(computed.expireAtEpochMs) ||
        computed.createdAtEpochMs < 0 ||
        computed.expireAtEpochMs <= computed.createdAtEpochMs ||
        !Array.isArray(computed.effects) ||
        computed.effects.length === 0 ||
        typeof computed.aggregateRef !== 'object' ||
        computed.aggregateRef === null ||
        typeof computed.aggregateRef.applicationId !== 'string' ||
        computed.aggregateRef.applicationId.length === 0 ||
        typeof computed.aggregateRef.workspaceId !== 'string' ||
        computed.aggregateRef.workspaceId.length === 0 ||
        typeof computed.audience !== 'object' ||
        computed.audience === null ||
        !['principal', 'group'].includes(computed.audience.kind) ||
        typeof computed.audience.applicationId !== 'string' ||
        computed.audience.applicationId.length === 0 ||
        typeof computed.audience.workspaceId !== 'string' ||
        computed.audience.workspaceId.length === 0 ||
        typeof computed.audience.resourceId !== 'string' ||
        computed.audience.resourceId.length === 0 ||
        computed.audience.applicationId !== computed.aggregateRef.applicationId ||
        computed.audience.workspaceId !== computed.aggregateRef.workspaceId
    ) {
        throw new TypeError('Computed state sync facts are invalid');
    }
    if (
        ('principalId' in computed.aggregateRef &&
            (
                computed.audience.kind !== 'principal' ||
                computed.audience.resourceId !== computed.aggregateRef.principalId
            )) ||
        ('groupId' in computed.aggregateRef &&
            (
                computed.audience.kind !== 'group' ||
                computed.audience.resourceId !== computed.aggregateRef.groupId
            ))
    ) {
        throw new TypeError('Computed state sync audience differs from aggregate');
    }
}

export function validateClientStateSyncEffect(
    computed: ComputedClientStateSync,
    effect: ComputedClientStateSyncEffect,
): void {
    if (
        typeof effect !== 'object' ||
        effect === null ||
        effect.effectKind !== 'principal-state'
    ) {
        throw new TypeError('Computed client state sync effect kind is invalid');
    }
    if (effect.payloadKind === 'snapshot') {
        validateAuthoritativeClientSnapshot(effect.payload, computed.aggregateRef);
        if (
            !sameClientRef(computed.aggregateRef, effect.payload) ||
            effect.payload.stateRevision !== computed.acceptedCausalRevision
        ) {
            throw new TypeError(
                'Computed client state sync snapshot differs from accepted authority',
            );
        }
        return;
    }
    if (effect.payloadKind === 'event') {
        validateAuthoritativeClientEvent(effect.payload, computed.aggregateRef);
        if (
            !sameClientRef(computed.aggregateRef, effect.payload) ||
            effect.payload.snapshotVersion !== computed.acceptedCausalRevision
        ) {
            throw new TypeError(
                'Computed client state sync event differs from accepted authority',
            );
        }
        return;
    }
    throw new TypeError('Computed client state sync payload kind is invalid');
}

export function validateGroupStateSyncEffect(
    computed: ComputedGroupStateSync,
    effect: ComputedGroupStateSyncEffect,
): void {
    if (typeof effect !== 'object' || effect === null) {
        throw new TypeError('Computed group state sync effect is invalid');
    }
    if (effect.payloadKind === 'snapshot') {
        if (
            effect.effectKind !== 'member-state' &&
            effect.effectKind !== 'scope-directory'
        ) {
            throw new TypeError('Computed group state sync effect kind is invalid');
        }
        validateAuthoritativeGroupSnapshot(effect.payload, computed.aggregateRef);
    } else if (effect.payloadKind === 'delta-envelope') {
        if (effect.effectKind !== 'member-state') {
            throw new TypeError('Computed group state sync effect kind is invalid');
        }
        validateGroupStateDeltaEnvelope(effect.payload, computed.aggregateRef);
    } else {
        throw new TypeError('Computed group state sync payload kind is invalid');
    }
    const identity = effect.payloadKind === 'delta-envelope'
        ? effect.payload.event
        : effect.payload;
    if (
        !sameGroupRef(computed.aggregateRef, identity) ||
        identity.causalRevision.groupRevision !==
            computed.acceptedCausalRevision.groupRevision ||
        identity.causalRevision.presenceRevision !==
            computed.acceptedCausalRevision.presenceRevision
    ) {
        throw new TypeError('Computed group state sync differs from accepted authority');
    }
}

export function isValidGroupCausalRevision(
    revision: GroupStateCausalRevision,
): boolean {
    return Number.isSafeInteger(revision.groupRevision) &&
        revision.groupRevision >= 0 &&
        Number.isSafeInteger(revision.presenceRevision) &&
        revision.presenceRevision >= 0;
}

function sameClientRef(
    ref: ClientPrincipalRef,
    value: ClientSnapshot | ClientEvent,
): boolean {
    const candidate = 'principal' in value ? value.principal : value;
    return ref.applicationId === candidate.applicationId &&
        ref.workspaceId === candidate.workspaceId &&
        ref.principalId === candidate.principalId;
}

function sameGroupRef(
    ref: GroupRef,
    value: GroupSnapshot | GroupEvent,
): boolean {
    const candidate = 'group' in value ? value.group : value;
    return ref.applicationId === candidate.applicationId &&
        ref.workspaceId === candidate.workspaceId &&
        ref.groupId === candidate.groupId;
}
