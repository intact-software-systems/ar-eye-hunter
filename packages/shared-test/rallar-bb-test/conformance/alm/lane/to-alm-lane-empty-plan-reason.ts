import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily, AlmConformanceTag } from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceScenario } from '../create-alm-conformance-recipes.ts';
import { isAlmLaneCellSelected } from './is-alm-lane-cell-selected.ts';

export interface ToAlmLaneEmptyPlanReasonInput {
    /** The scenario keys `RALLAR_BLACK_BOX_ALM_ONLY` names; empty when it is not set. */
    readonly only: readonly string[];
    readonly family: AlmConformanceLaneFamily;
    readonly carrier: AlmConformanceCarrier;
    readonly scope: AlmConformanceTag;
    /** The scenario ids `RALLAR_BLACK_BOX_ALM_SKIP` withholds. */
    readonly skip: readonly string[];
    /** The family's catalog cells on the carrier, before `only` narrows them. */
    readonly scenarios: readonly Pick<AlmConformanceScenario, 'scenarioId' | 'tags'>[];
    /** The reason when the catalog alone, not a named cell, left the family nothing to run. */
    readonly otherwise: string;
}

/**
 * Why a family that plans no cell over a carrier is skipped. A named cell of another family is the user's own doing,
 * but only when the family would have run cells without `only`; a family empty for another cause keeps its own reason.
 */
export function toAlmLaneEmptyPlanReason(input: ToAlmLaneEmptyPlanReasonInput): string {
    const selection = { scope: input.scope, carriers: [input.carrier], skip: input.skip };
    const runsWithoutOnly = input.scenarios.some((scenario) =>
        isAlmLaneCellSelected({ ...scenario, carrier: input.carrier }, selection)
    );
    return input.only.length > 0 && runsWithoutOnly
        ? `RALLAR_BLACK_BOX_ALM_ONLY=${input.only.join(',')} plans no cell of ${input.family} over ${input.carrier}`
        : input.otherwise;
}
