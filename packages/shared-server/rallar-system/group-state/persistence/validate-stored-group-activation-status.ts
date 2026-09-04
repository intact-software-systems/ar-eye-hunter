import { GROUP_ACTIVATION_CONDITIONS } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import {
    GROUP_ACTIVATION_STATUS_KEYS,
    GROUP_EVIDENCE_WATERMARK_KEYS
} from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';

import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf,
    requireRecord
} from '../group-state-validation-primitives.ts';

/**
 * The stored observed status, validated whole. It lives beside the group
 * validator rather than inside it because the group's own validator is
 * already decision-dense, and this block is one self-contained shape.
 *
 * The layout-identity check is passed in rather than duplicated: the basis
 * is the same shape as the accepted layout, and one check for both keeps
 * them from drifting.
 */
export function validateStoredGroupActivationStatus(
    activationStatus: Readonly<Record<string, unknown>>,
    validateLayoutIdentity: (identity: Readonly<Record<string, unknown>>, label: string) => void
): void {
    assertExactKeys(activationStatus, GROUP_ACTIVATION_STATUS_KEYS, 'Stored group activationStatus');
    assertRequiredKeys(activationStatus, GROUP_ACTIVATION_STATUS_KEYS, 'Stored group activationStatus');
    requireOneOf(
        activationStatus.condition,
        GROUP_ACTIVATION_CONDITIONS,
        'Stored group activationStatus condition'
    );
    const coverageRate = activationStatus.coverageRate;
    if (
        typeof coverageRate !== 'number' || !Number.isFinite(coverageRate) ||
        coverageRate < 0 || coverageRate > 1
    ) {
        throw new TypeError('Stored group activationStatus coverageRate must be a rate between 0 and 1');
    }
    requireNonNegativeSafeInteger(
        activationStatus.formationEpoch,
        'Stored group activationStatus formationEpoch'
    );
    requireNonNegativeSafeInteger(
        activationStatus.confirmedAtEpochMs,
        'Stored group activationStatus confirmedAtEpochMs'
    );
    validateLayoutIdentity(
        requireRecord(
            activationStatus.coverageBasisLayoutIdentity,
            'Stored group activationStatus coverageBasisLayoutIdentity'
        ),
        'Stored group activationStatus coverageBasisLayoutIdentity'
    );
    if (activationStatus.evidenceWatermark !== null) {
        const watermark = requireRecord(
            activationStatus.evidenceWatermark,
            'Stored group activationStatus evidenceWatermark'
        );
        assertExactKeys(watermark, GROUP_EVIDENCE_WATERMARK_KEYS, 'Stored group activationStatus evidenceWatermark');
        assertRequiredKeys(watermark, GROUP_EVIDENCE_WATERMARK_KEYS, 'Stored group activationStatus evidenceWatermark');
        for (const key of GROUP_EVIDENCE_WATERMARK_KEYS) {
            requireNonNegativeSafeInteger(
                watermark[key],
                `Stored group activationStatus evidenceWatermark ${key}`
            );
        }
    }
}
