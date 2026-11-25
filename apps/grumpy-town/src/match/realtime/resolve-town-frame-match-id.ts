import type { TownMatchCheckpoints } from '../agreement/match-checkpoints.ts';
import type { TownMatchFrame } from '../match-protocol.ts';

export function resolveTownFrameMatchId(
    frame: TownMatchFrame,
    checkpointState: TownMatchCheckpoints.State | undefined
): string | undefined {
    const current = checkpointState?.pending?.checkpoint.state ?? checkpointState?.committed?.state;
    const retained = checkpointState?.committed;
    const action = frame.action;
    const recoveryIdentity = action.kind === 'recover' &&
        [retained, checkpointState?.recoveryCheckpoint, ...checkpointState?.retainedProposals ?? []].some((
            checkpoint
        ) => checkpoint?.state.matchId === frame.matchId && checkpoint.epoch === action.checkpointEpoch &&
            checkpoint.sequence === action.proposalSequence && checkpoint.digest === action.digest
        );
    const retainedIdentity = retained && frame.epoch === retained.epoch &&
        frame.matchId === retained.state.matchId &&
        ((action.kind === 'proposal' && frame.sequence === retained.sequence &&
            action.digest === retained.digest) ||
            ((action.kind === 'ack' || action.kind === 'commit') && action.proposalSequence === retained.sequence &&
                action.digest === retained.digest));
    const nextLobby = current && (current.phase === 'finished' || current.phase === 'interrupted') &&
        frame.action.kind === 'proposal';
    if (recoveryIdentity || retainedIdentity) {
        return frame.matchId;
    }
    return nextLobby ? undefined : current?.matchId;
}
