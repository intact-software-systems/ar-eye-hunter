export namespace AuthMutationRejectedError {
    export interface ConsumeRead {
        readonly consumeRequestId: string;
        readonly expectedSessionId: string;
        readonly capturedAtEpochMs: number;
        readonly ticketRead: 'live' | 'expired' | 'absent';
        readonly storageExpiresAtEpochMs: number | null;
        readonly ticketSessionId: string | null;
        readonly ticketIssuedAtEpochMs: number | null;
        readonly ticketExpiresAtEpochMs: number | null;
    }
}

export class AuthMutationRejectedError extends Error {
    readonly code = 'auth-mutation-rejected';

    readonly status: number;

    consumeRead: AuthMutationRejectedError.ConsumeRead | undefined;

    constructor(
        message: string,
        status = 409
    ) {
        super(message);
        this.status = status;
        this.name = 'AuthMutationRejectedError';
    }

    setConsumeRead(consumeRead: AuthMutationRejectedError.ConsumeRead): void {
        this.consumeRead = consumeRead;
    }
}
