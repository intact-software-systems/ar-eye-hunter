export class ControlRunManagerHttpError extends Error {
    readonly status: number;
    readonly statusText: string;

    constructor(message: string, status: number, statusText: string) {
        super(message);
        this.name = 'ControlRunManagerHttpError';
        this.status = status;
        this.statusText = statusText;
    }
}
