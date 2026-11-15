import { computeReplacedLayoutForwardingMs } from '@shared/multicast/room-authority/resolve-rtc-room-routing-edges.ts';

import type { RallarBlackBoxTestWaitCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toPauseCommand } from '../to-pause-command.ts';

/**
 * The page waits out the forwarding window of the layout the reshape replaced: a sender forwards over that layout for
 * the first part of the overlap the server states (`computeReplacedLayoutForwardingMs`), so a send inside it can leave
 * on a direct edge the path no longer has. No page-observable witness of the window's end exists today, so the settle
 * waits the bound itself; the bound is the server's, read from `/api/config` by the lane, never a constant of its own.
 * The wait starts once the page accepted the layout its head read names, so it covers that promotion only: a later
 * promotion, an RTT re-plan or a presence change during the wait or the body, opens a window of its own that nothing
 * here waits out.
 */
export function toReplacedLayoutForwardingWait(
    step: AlmConformanceStepInput,
    statedOverlapMs: number
): RallarBlackBoxTestWaitCommand {
    return toPauseCommand(step, 'replaced-layout-forwarding', computeReplacedLayoutForwardingMs(statedOverlapMs));
}
