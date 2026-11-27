/**
 * The only way an admission conflict may leave a `write` callback. Every backend commits whatever the
 * callback wrote once it returns, so a callback that finds its guard no longer holds throws this instead:
 * the transaction aborts with nothing written. A backend throws it too when a fenced row or an observed
 * work row moved before the commit. The store that owns the callback catches it at its public boundary
 * and returns the typed `'conflict'` value its callers read.
 */
export class ALAdmissionBackendConflictError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ALAdmissionBackendConflictError';
    }
}
