import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { readGroupDisplayName, readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { RuntimeStateJsonStore } from '../../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../../runtime-state/runtime-state-repository.ts';
import { sha256CanonicalJson } from '../../../group-state/mutation/group-state-crypto.ts';
import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { compareRtcTopologyIdentifiers } from '../../persistence/rtc-topology-identifiers.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { RtcTopologyKindHysteresisWidths } from '../../runtime/rallar-rtc-topology-service.ts';

export const RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE = 'rtc-topology:input-fingerprints';

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

    /**
     * Absent, foreign-scope, or malformed rows read as null so the fingerprint
     * gate fails open into a normal rebuild instead of a wrong skip.
     */
    async findFingerprint(ref: GroupRef): Promise<string | null> {
        const stored = await this.getJsonValue(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        return stored === undefined
            ? null
            : decodeStoredRtcTopologyInputFingerprint(stored, ref)?.fingerprint ?? null;
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
): StoredRtcTopologyInputFingerprint | null {
    if (
        !isExactJsonWireObject(value, ['groupRef', 'fingerprint']) ||
        !isExactJsonWireObject(value.groupRef, ['applicationId', 'workspaceId', 'groupId']) ||
        value.groupRef.applicationId !== expectedRef.applicationId ||
        value.groupRef.workspaceId !== expectedRef.workspaceId ||
        value.groupRef.groupId !== expectedRef.groupId ||
        typeof value.fingerprint !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)
    ) {
        return null;
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
