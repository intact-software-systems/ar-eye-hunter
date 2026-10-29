import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';

import type { RallarBlackBoxTestWaitCommand } from '../../rallar-black-box-test-contracts.ts';

import { RESPONSE_MARGIN_MS } from './alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId } from './alm-conformance-step-identities.ts';

/** Nothing emits this topic: the wait that names it only holds its page quiet for its timeout. */
const PAUSE_TOPIC = 'rallar.black-box.alm.pause';

/** A pause of `durationMs` between two commands; the harness has no sleep command, and an absence wait is one. */
export function toPauseCommand(
    step: AlmConformanceStepInput,
    name: string,
    durationMs: number
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: { kind: 'diagnostic', topic: PAUSE_TOPIC },
        absent: true,
        timeoutMs: durationMs
    };
}

/**
 * Holds a successor's connect until the closed owner page's last work lease has lapsed. A held claim stays reserved
 * until its lease ends, so a takeover before then finds the row leased and its first batch claims nothing; after it,
 * that batch claims the row.
 */
export function toOwnerLeaseLapseWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return toPauseCommand(step, 'owner-lease-lapses', AL_OUTBOUND_WORK_LEASE_MS + RESPONSE_MARGIN_MS);
}
