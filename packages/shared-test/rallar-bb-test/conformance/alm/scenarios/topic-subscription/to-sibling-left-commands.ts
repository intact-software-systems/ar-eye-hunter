import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toAlmCellBarrierCommandId } from '../../cell/to-alm-cell-barrier.ts';
import { toAlmCellCommandPrefix } from '../../cell/to-alm-cell-command-prefix.ts';
import { toHeldGroupAppliedMatch } from '../../cell/to-held-group-applied-match.ts';
import { SUBSCRIPTION_PHASE_MS } from '../../granted-topic/subscription-phase-budgets.ts';
import { toPollChildId, toPollCommand } from '../../poll/alm-conformance-poll-commands.ts';
import { toDepartingCueSendCommands } from './to-departing-cue-send-commands.ts';
import { toResultTextWait } from './topic-subscription-budgets.ts';
import { toRoomSnapshotCommand } from './topic-subscription-generation-polls.ts';
import { toCueWait } from './topic-subscription-publications.ts';

/** The cue the sibling sends before it closes its socket: the cue's sender is the sibling's own session. */
const LEAVING_CUE = 'leaving';

/** The sibling's leaving cue, which the room acknowledged before the sibling's socket closes. */
export function toSiblingLeavingCueCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toDepartingCueSendCommands(sibling, LEAVING_CUE);
}

/**
 * The sibling's own session left the room, and the producer's page applied it. The producer reads that session from
 * the sender of the sibling's leaving cue and re-reads the room until no presence names it, so another role's
 * departure, such as a failed recipe's cleanup, is never taken for the sibling's. Its page then applies a room
 * snapshot with one session fewer than the cell's roles, before it probes.
 */
export function toSiblingLeftCommands(producer: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueWait(producer, LEAVING_CUE);
    return [
        cue,
        toSessionGonePollCommand(producer, `{resultCache.${cue.commandId}.value.event.payload.senderId}`),
        toSiblingLeftWait(producer)
    ];
}

/**
 * Re-reads the room's snapshot until no active session is `sessionId`. The match reads the snapshot's presences alone:
 * every role wrote its own membership, so the sibling's session stays in its member's audit stamps after it left.
 */
function toSessionGonePollCommand(step: AlmConformanceStepInput, sessionId: string): RallarBlackBoxTestCommand {
    const name = 'sibling-session-gone';
    const readName = `${name}-read`;
    const attemptRead = toPollChildId({ step, name, index: 1, childId: toCommandId(step, readName) });
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commands: [
            toRoomSnapshotCommand(step, readName),
            toResultTextWait({
                step,
                name: `${name}-absent`,
                commandId: attemptRead,
                topic: 'rallar.bb.http.response',
                text: `"sessionId":"${sessionId}"`,
                absent: true,
                payloadPath: 'body.activeSessions'
            })
        ]
    });
}

/**
 * The page applied a room snapshot with one session fewer than the cell's roles. The count is read from the cell's
 * `armed` barrier onward, when every role connected, so the one way to reach it is a removal; the cell's room is its
 * own, so no session of an earlier cell is left in it. It only works in a cell created with a barriered `cellSettle`:
 * without an `armed` command the page falls back to the next event and the wait times out, so a hosted manifest for
 * this cell must carry an `armed` barrier.
 */
function toSiblingLeftWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, 'sibling-left'),
        match: {
            ...toHeldGroupAppliedMatch(step, { 'data.activeSessionCount': step.roles.length - 1 }),
            sinceCommandIdPrefix: toAlmCellBarrierCommandId({
                cellPrefix: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
                role: step.role,
                phase: 'armed'
            })
        },
        timeoutMs: SUBSCRIPTION_PHASE_MS
    };
}
