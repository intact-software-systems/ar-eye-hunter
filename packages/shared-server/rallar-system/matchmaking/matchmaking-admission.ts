import type { NewGroupCohortAdmissionInput } from '../group-state/mutation/membership/compute-new-group-cohort-admission.ts';
import { readNewGroupCohortAdmission } from '../group-state/mutation/membership/read-new-group-cohort-admission.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import type { MatchmakingCommand } from './matchmaking-command.ts';
import type { MatchmakingProposal } from './matchmaking-pool.ts';

export interface MatchmakingAdmissionReadInput {
    readonly groups: GroupStateRepository;
    readonly proposal: MatchmakingProposal;
    readonly command: MatchmakingCommand;
    readonly nowEpochMs: number;
    readonly attemptCount: number;
    readonly traceId: string;
    readonly finishedRetentionMs: number;
}

/** Matchmaking consent and identities become ordinary group creation/join commands in the group owner. */
export async function readMatchmakingAdmission(
    input: MatchmakingAdmissionReadInput
): Promise<NewGroupCohortAdmissionInput> {
    const { capturedAtEpochMs, serviceId } = input.command;
    if (capturedAtEpochMs === null || serviceId === null) {
        throw new TypeError('Matchmaking admission requires captured facts');
    }
    const { roomRef } = input.proposal;
    return await readNewGroupCohortAdmission({
        groups: input.groups,
        roomRef,
        displayName: 'Matched room',
        maxSpectators: null,
        capturedAtEpochMs,
        serviceId,
        nowEpochMs: input.nowEpochMs,
        attemptCount: input.attemptCount,
        traceId: input.traceId,
        finishedRetentionMs: input.finishedRetentionMs,
        participants: input.proposal.participants.map((actor, index) => ({
            principalId: actor.principalId,
            sessionId: actor.sessionId,
            requestId: index === 0
                ? `match-create:${roomRef.groupId}`
                : `match-join:${computeSha256CanonicalJson({ roomRef, principalId: actor.principalId }).slice(0, 32)}`
        }))
    });
}
