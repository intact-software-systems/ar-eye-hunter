export class ClientMutationRejectedError extends Error {
    readonly code = 'client-mutation-rejected';
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'ClientMutationRejectedError';
    }
}

export interface ClientMutationValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: ClientMutationRejectedError;
}

export function toClientMutationValidationIssue(
    path: string,
    message: string
): ClientMutationValidationIssue {
    return { path, message, cause: new ClientMutationRejectedError(message) };
}

export function rejectClientMutation(message: string): never {
    throw new ClientMutationRejectedError(message);
}
