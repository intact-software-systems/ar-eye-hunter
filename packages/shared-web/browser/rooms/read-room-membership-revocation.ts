import { ApiHttpError } from '../api/http-error.ts';

/** Only an explicit policy refusal proves revocation; absence and transport failure do not. */
export function readRoomMembershipRevocation(error: unknown): 'banned' | 'removed' | undefined {
    if (!(error instanceof ApiHttpError) || error.status !== 403) {
        return undefined;
    }
    if (error.policyError?.code === 'member-banned') {
        return 'banned';
    }
    return error.policyError?.code === 'member-removed' ? 'removed' : undefined;
}
