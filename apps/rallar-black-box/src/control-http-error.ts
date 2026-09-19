export class ControlHttpError extends Error {
    readonly status: number;
    readonly statusText: string;

    constructor(message: string, status: number, statusText: string) {
        super(message);
        this.name = 'ControlHttpError';
        this.status = status;
        this.statusText = statusText;
    }
}
