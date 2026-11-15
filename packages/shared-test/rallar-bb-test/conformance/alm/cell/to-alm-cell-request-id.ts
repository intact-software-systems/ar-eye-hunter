import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';

/** A mutation request id of a cell's role: the page's runtime identity keeps a rerun from replaying an earlier answer. */
export function toAlmCellRequestId(step: AlmConformanceStepInput, name: string): string {
    return `alm-conformance-{runtimeIdentity}${toAlmCellRequestIdSuffix(step, name)}`;
}

/** What follows the writer page's runtime identity in a request id; another page names a write by it. */
export function toAlmCellRequestIdSuffix(step: AlmConformanceStepInput, name: string): string {
    return `-${step.input.carrier}-${step.scenarioKey}-${step.role}-${name}`;
}
