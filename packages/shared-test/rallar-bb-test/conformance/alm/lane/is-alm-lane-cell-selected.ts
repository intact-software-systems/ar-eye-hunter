import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceTag } from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceScenario } from '../create-alm-conformance-recipes.ts';

/** What a run selects of the catalog: `RALLAR_BLACK_BOX_ALM_SCOPE`, `_CARRIERS` and `_SKIP`. */
export interface AlmLaneCellSelection {
    readonly scope: AlmConformanceTag;
    readonly carriers: readonly AlmConformanceCarrier[];
    /** The scenario ids a recorded ruling withholds. */
    readonly skip: readonly string[];
}

interface AlmLaneSelectableCell extends Pick<AlmConformanceScenario, 'scenarioId' | 'tags'> {
    readonly carrier: AlmConformanceCarrier;
}

/** The one rule that says whether a cell is among those a run selects, before `RALLAR_BLACK_BOX_ALM_ONLY` narrows them. */
export function isAlmLaneCellSelected(cell: AlmLaneSelectableCell, selection: AlmLaneCellSelection): boolean {
    return selection.carriers.includes(cell.carrier) && cell.tags.includes(selection.scope) &&
        !selection.skip.includes(cell.scenarioId);
}
