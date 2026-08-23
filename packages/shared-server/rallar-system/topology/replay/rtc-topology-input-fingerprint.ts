import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { readGroupDisplayName, readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { RuntimeStateJsonStore } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/RuntimeStateRepository.ts';
import { sha256CanonicalJson } from '../../group-state/mutation/group-state-crypto.ts';
import { compareRtcTopologyIdentifiers } from '../persistence/rtc-topology-identifiers.ts';
import type { GroupTopologyPlanningAuthority } from '../planning/group-topology-planning-authority.ts';
import type { RtcTopologyKindHysteresisWidths } from '../runtime/rallar-rtc-topology-service.ts';

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
        const stored = await this.getValue<StoredRtcTopologyInputFingerprint>(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        if (
            !stored ||
            typeof stored.fingerprint !== 'string' ||
            !/^sha256:[0-9a-f]{64}$/.test(stored.fingerprint) ||
            stored.groupRef?.applicationId !== ref.applicationId ||
            stored.groupRef?.workspaceId !== ref.workspaceId ||
            stored.groupRef?.groupId !== ref.groupId
        ) {
            return null;
        }
        return stored.fingerprint;
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
