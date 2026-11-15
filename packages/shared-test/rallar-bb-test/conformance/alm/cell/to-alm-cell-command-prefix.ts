import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';

/** `alm-<carrier>-<scenarioKey>`: every command id of the cell, and each of its barrier ids, starts with it. */
export function toAlmCellCommandPrefix(carrier: AlmConformanceCarrier, scenarioKey: string): string {
    return `alm-${carrier}-${scenarioKey}`;
}
