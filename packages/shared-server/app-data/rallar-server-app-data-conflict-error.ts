export namespace RallarServerAppDataConflictError {
    export interface Input {
        readonly operation: string;
        readonly key: string;
        readonly maxAttempts: number;
    }
}

export class RallarServerAppDataConflictError extends Error {
    readonly operation: string;
    readonly key: string;
    readonly maxAttempts: number;

    constructor(input: RallarServerAppDataConflictError.Input) {
        super(
            `Rallar server app data ${input.operation} conflicted for key ${input.key} after ${input.maxAttempts} attempts.`
        );
        this.name = 'RallarServerAppDataConflictError';
        this.operation = input.operation;
        this.key = input.key;
        this.maxAttempts = input.maxAttempts;
    }
}
