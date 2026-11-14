import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '../alm-conformance-scenario-definition.ts';

export interface ToAlmLaneEmptyPlanReasonInput {
    /** The scenario keys `RALLAR_BLACK_BOX_ALM_ONLY` names; empty when it is not set. */
    readonly only: readonly string[];
    readonly family: AlmConformanceLaneFamily;
    readonly carrier: AlmConformanceCarrier;
    /** The reason when the catalog alone, not a named cell, left the family nothing to run. */
    readonly otherwise: string;
}

/** Why a family that plans no cell over a carrier is skipped: a named cell of another family is the user's own doing. */
export function toAlmLaneEmptyPlanReason(input: ToAlmLaneEmptyPlanReasonInput): string {
    return input.only.length === 0
        ? input.otherwise
        : `RALLAR_BLACK_BOX_ALM_ONLY=${input.only.join(',')} plans no cell of ${input.family} over ${input.carrier}`;
}
