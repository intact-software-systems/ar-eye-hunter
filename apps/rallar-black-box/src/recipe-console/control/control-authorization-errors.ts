import { ControlRunManagerHttpError } from '../../control-http-error.ts';

export class RecipeConsoleControlAuthorizationError extends Error {
    readonly reachable = true;
    readonly authorizationRequired = true;
    readonly controlStatus: number;
    readonly controlStatusText: string;
    readonly brokerStatus?: number;
    readonly brokerStatusText?: string;
    readonly brokerError: unknown;

    constructor(
        controlError: ControlRunManagerHttpError,
        brokerError: unknown
    ) {
        super(controlAuthorizationErrorMessage(brokerError));
        this.name = 'RecipeConsoleControlAuthorizationError';
        this.controlStatus = controlError.status;
        this.controlStatusText = controlError.statusText;
        this.brokerStatus = httpStatus(brokerError);
        this.brokerStatusText = httpStatusText(brokerError);
        this.brokerError = brokerError;
    }
}

export class RecipeConsoleControlCredentialTrustError extends ControlRunManagerHttpError {
    readonly reachable = true;
    readonly authorizationRequired = true;
    readonly credentialTrustRequired = true;

    constructor(
        controlError: ControlRunManagerHttpError,
        message: string
    ) {
        super(message, controlError.status, controlError.statusText);
        this.name = 'RecipeConsoleControlCredentialTrustError';
    }
}

export function controlAuthorizationErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function httpStatus(error: unknown): number | undefined {
    return error && typeof error === 'object' &&
            'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
}

function httpStatusText(error: unknown): string | undefined {
    return error && typeof error === 'object' &&
            'statusText' in error && typeof error.statusText === 'string'
        ? error.statusText
        : undefined;
}
