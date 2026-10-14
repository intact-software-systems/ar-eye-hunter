/** Expected command rejection crosses the exception-based queue handler without indicating an operational failure. */
export class ResourceInboxCommandRejectedError extends Error {
    readonly code: string;

    constructor(code: string, cause: Error) {
        super(cause.message, { cause });
        this.code = code;
        this.name = 'ResourceInboxCommandRejectedError';
    }
}
