import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';

/** One job of the `alm-conformance-observation` matrix: a carrier and its family list, empty for every family. */
export interface AlmObservationMatrixEntry {
    readonly carrier: AlmConformanceCarrier;
    readonly families: string;
}

/** The `matrix.*` values a job of the entry evaluates its expressions against. */
export function toAlmObservationMatrixValues(entry: AlmObservationMatrixEntry): Readonly<Record<string, string>> {
    return { 'matrix.carrier': entry.carrier, 'matrix.families': entry.families };
}
