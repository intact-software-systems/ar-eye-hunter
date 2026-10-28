import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';

/** A command the server issues for one group, under the trace of the message that caused it. */
export interface GroupSystemCommandSubmission {
    readonly command: GroupMutationCommand;
    readonly atEpochMs: number;
    readonly traceId: string;
}

export interface GroupSystemCommandPort {
    submitCommand(submission: GroupSystemCommandSubmission): Promise<void>;
}
