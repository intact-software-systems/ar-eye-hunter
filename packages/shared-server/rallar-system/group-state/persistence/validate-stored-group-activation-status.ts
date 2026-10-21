import { GROUP_ACTIVATION_CONDITIONS } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import {
    GROUP_ACTIVATION_STATUS_KEYS,
    GROUP_EVIDENCE_WATERMARK_KEYS
} from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';

import type { ValidationRecord } from '../../protocol/validation-value.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf,
    requireRecord
} from '../group-state-validation-primitives.ts';
import { requireUnitRate } from '../require-unit-rate.ts';

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
    activationStatus: ValidationRecord,
    validateLayoutIdentity: (identity: ValidationRecord, label: string) => void
): void {
    assertExactKeys(activationStatus, GROUP_ACTIVATION_STATUS_KEYS, 'Stored group activationStatus');
    assertRequiredKeys(activationStatus, GROUP_ACTIVATION_STATUS_KEYS, 'Stored group activationStatus');
    requireOneOf(
        activationStatus.condition,
        GROUP_ACTIVATION_CONDITIONS,
        'Stored group activationStatus condition'
    );
    requireUnitRate(activationStatus.coverageRate, 'Stored group activationStatus coverageRate');
    requireNonNegativeSafeInteger(
        activationStatus.formationEpoch,
        'Stored group activationStatus formationEpoch'
    );
    requireNonNegativeSafeInteger(
        activationStatus.publishedAtEpochMs,
        'Stored group activationStatus publishedAtEpochMs'
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
