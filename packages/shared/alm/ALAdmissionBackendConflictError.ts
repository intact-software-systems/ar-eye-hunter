/**
 * The only way an admission conflict may leave a `write` callback. Every backend commits whatever
 * the callback returns, and a commit that merely read metadata still bumps the admission revision,
 * which invalidates every other in-flight optimistic write. Throwing aborts the transaction with no
 * write and no revision bump; the store that owns the callback catches this at its public boundary
 * and returns the typed `'conflict'` value its callers read.
 */
export class ALAdmissionBackendConflictError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ALAdmissionBackendConflictError';
    }
}
