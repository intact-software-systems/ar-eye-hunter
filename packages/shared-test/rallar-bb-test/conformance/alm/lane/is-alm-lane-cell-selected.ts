import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily, AlmConformanceTag } from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceScenario } from '../create-alm-conformance-recipes.ts';

/** What a run selects of the catalog: `RALLAR_BLACK_BOX_ALM_SCOPE`, `_CARRIERS`, `_FAMILIES` and `_SKIP`. */
export interface AlmLaneCellSelection {
    readonly scope: AlmConformanceTag;
    readonly carriers: readonly AlmConformanceCarrier[];
    readonly families: readonly AlmConformanceLaneFamily[];
    /** The scenario ids a recorded ruling withholds. */
    readonly skip: readonly string[];
}

interface AlmLaneSelectableCell extends Pick<AlmConformanceScenario, 'scenarioId' | 'tags'> {
    readonly carrier: AlmConformanceCarrier;
    readonly family: AlmConformanceLaneFamily;
}

/** The one rule that says whether a cell is among those a run selects, before `RALLAR_BLACK_BOX_ALM_ONLY` narrows them. */
export function isAlmLaneCellSelected(cell: AlmLaneSelectableCell, selection: AlmLaneCellSelection): boolean {
    return selection.carriers.includes(cell.carrier) && isAlmLaneFamilySelected(selection.families, cell.family) &&
        cell.tags.includes(selection.scope) && !selection.skip.includes(cell.scenarioId);
}

/** Whether `RALLAR_BLACK_BOX_ALM_FAMILIES` selects a family: the one family rule of the lane. */
export function isAlmLaneFamilySelected(
    families: readonly AlmConformanceLaneFamily[],
    family: AlmConformanceLaneFamily
): boolean {
    return families.includes(family);
}

/** Why a family test is skipped when `RALLAR_BLACK_BOX_ALM_FAMILIES` does not select its family; none when it does. */
export function toAlmLaneUnselectedFamilyReason(
    families: readonly AlmConformanceLaneFamily[],
    family: AlmConformanceLaneFamily
): string | undefined {
    return isAlmLaneFamilySelected(families, family)
        ? undefined
        : `RALLAR_BLACK_BOX_ALM_FAMILIES=${families.join(',')} does not select ${family}`;
}
