export class ALAdmissionBackendConflictError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ALAdmissionBackendConflictError';
    }
}
