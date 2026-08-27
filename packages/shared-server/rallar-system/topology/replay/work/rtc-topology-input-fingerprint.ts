import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { readGroupDisplayName, readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { RuntimeStateJsonStore } from '../../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../../runtime-state/runtime-state-repository.ts';
import { sha256CanonicalJson } from '../../../protocol/canonical-json.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../persistence/rtc-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from '../../persistence/rtc-topology-identifiers.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { RtcTopologyKindHysteresisWidths } from '../../runtime/rallar-rtc-topology-service.ts';

export const RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE = 'rtc-topology:input-fingerprints';

/** The fingerprint copied at promotion (plan slice 4a): accepted beside planned. */
export const RTC_TOPOLOGY_ACCEPTED_INPUT_FINGERPRINTS_NAMESPACE = 'rtc-topology:accepted-input-fingerprints';

/** The stored fingerprint row encoding, shared by putFingerprint and the promotion effect. */
export function toStoredRtcTopologyInputFingerprintValue(ref: GroupRef, fingerprint: string): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
        throw new TypeError('RTC topology input fingerprint is invalid');
    }
    const stored: StoredRtcTopologyInputFingerprint = {
        groupRef: {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId
        },
        fingerprint
    };
    return JSON.stringify(stored);
}

export interface RtcTopologyInputFingerprintFacts {
    readonly group: GroupSnapshot;
    readonly effectiveConfig: EffectiveGroupTopologyConfig;
    readonly kindHysteresisWidths: RtcTopologyKindHysteresisWidths;
}

export function computeAuthorityTopologyInputFingerprint(
    authority: GroupTopologyPlanningAuthority
): Promise<string> {
    return computeRtcTopologyInputFingerprint({
        group: authority.group,
        effectiveConfig: authority.config.effective,
        kindHysteresisWidths: authority.kindHysteresisWidths
    });
}

interface StoredRtcTopologyInputFingerprint {
    readonly groupRef: GroupRef;
    readonly fingerprint: string;
}

export async function computeRtcTopologyInputFingerprint(
    facts: RtcTopologyInputFingerprintFacts
): Promise<string> {
    const digest = await sha256CanonicalJson({
        activeSessionIds: [...readGroupMemberSessionIds(facts.group)].sort(
            compareRtcTopologyIdentifiers
        ),
        displayName: readGroupDisplayName(facts.group),
        effectiveConfig: {
            topologyKind: facts.effectiveConfig.topologyKind,
            degreeLimit: facts.effectiveConfig.degreeLimit,
            treeMinSize: facts.effectiveConfig.treeMinSize,
            meshMinSize: facts.effectiveConfig.meshMinSize,
            meshParamK: facts.effectiveConfig.meshParamK
        },
        kindHysteresisWidths: {
            meshExitWidth: facts.kindHysteresisWidths.meshExitWidth,
            treeExitWidth: facts.kindHysteresisWidths.treeExitWidth
        }
    });
    return `sha256:${digest}`;
}

export class RtcTopologyInputFingerprintRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;

    constructor(runtimeRepository: RuntimeStateRepositoryLike) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
    }

    async findFingerprint(ref: GroupRef): Promise<string | null> {
        const storageKey = groupStateGroupStorageKey(ref);
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            storageKey
        );
        if (!entry || entry.expireAtTimestamp <= Date.now()) {
            return null;
        }
        try {
            const stored = decodeJsonWireValue(
                JSON.parse(entry.value),
                'Stored RTC topology input fingerprint'
            );
            return decodeStoredRtcTopologyInputFingerprint(stored, ref).fingerprint;
        }
        catch (error) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                storageKey,
                error instanceof Error
                    ? error.message
                    : 'Stored RTC topology input fingerprint is invalid'
            );
        }
    }

    async putFingerprint(ref: GroupRef, fingerprint: string): Promise<void> {
        if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
            throw new TypeError('RTC topology input fingerprint is invalid');
        }
        const stored: StoredRtcTopologyInputFingerprint = {
            groupRef: {
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId,
                groupId: ref.groupId
            },
            fingerprint
        };
        await this.putValue(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            groupStateGroupStorageKey(ref),
            stored,
            NEVER_EXPIRE_AT_TIMESTAMP
        );
    }
}

function decodeStoredRtcTopologyInputFingerprint(
    value: JsonWireValue,
    expectedRef: GroupRef
): StoredRtcTopologyInputFingerprint {
    if (!isExactJsonWireObject(value, ['groupRef', 'fingerprint'])) {
        throw new TypeError('Stored RTC topology input fingerprint fields are invalid');
    }
    if (!isExactJsonWireObject(value.groupRef, ['applicationId', 'workspaceId', 'groupId'])) {
        throw new TypeError('Stored RTC topology input fingerprint group identity is invalid');
    }
    if (
        value.groupRef.applicationId !== expectedRef.applicationId ||
        value.groupRef.workspaceId !== expectedRef.workspaceId ||
        value.groupRef.groupId !== expectedRef.groupId
    ) {
        throw new TypeError('Stored RTC topology input fingerprint group identity is inconsistent');
    }
    if (typeof value.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)) {
        throw new TypeError('Stored RTC topology input fingerprint digest is invalid');
    }
    return {
        groupRef: {
            applicationId: value.groupRef.applicationId,
            workspaceId: value.groupRef.workspaceId,
            groupId: value.groupRef.groupId
        },
        fingerprint: value.fingerprint
    };
}

function isExactJsonWireObject(
    value: JsonWireValue,
    keys: readonly string[]
): value is JsonWireObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const actualKeys = Object.keys(value).toSorted();
    const expectedKeys = keys.toSorted();
    return actualKeys.length === expectedKeys.length &&
        actualKeys.every((key, index) => key === expectedKeys[index]);
}
