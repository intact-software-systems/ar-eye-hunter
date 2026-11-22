import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmLaneRunIdentity } from '../lane-result/alm-lane-result.ts';

/**
 * The name of a lane job in `alm-conformance-observation.yml`, with its carrier captured. A repository test pins it
 * against the workflow.
 */
export const ALM_LANE_JOB_NAME_PATTERN = /^ALM conformance observation \((.*)\)$/;

/** The identity every file of a run the ledger reads states, beside the job's carrier. */
export const ALM_LANE_LEDGER_IDENTITY: Omit<AlmLaneRunIdentity, 'carrier'> = { scope: 'full', backend: 'postgres' };

/** The start of a carrier's result artifact name; a repository test pins it against the lane results action. */
export function toAlmLaneResultArtifactPrefix(carrier: AlmConformanceCarrier): string {
    return `alm-lane-result-${carrier}-${ALM_LANE_LEDGER_IDENTITY.scope}-`;
}
