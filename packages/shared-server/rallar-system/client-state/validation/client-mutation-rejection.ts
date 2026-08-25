export class ClientMutationRejectedError extends Error {
    readonly code = 'client-mutation-rejected';
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'ClientMutationRejectedError';
    }
}

export function rejectClientMutation(message: string): never {
    throw new ClientMutationRejectedError(message);
}
