import { Either } from '@shared/resilience/Either.ts';

import type { ControlServiceFailure } from '../control-service.ts';
import type { ControlHttpRejection } from '../http/control-http-responses.ts';

export const ADMIN_TOKEN_REJECTION: ControlHttpRejection = {
    status: 401,
    message: 'Admin token is required or invalid.'
};

export const RUN_TOKEN_REJECTION: ControlHttpRejection = {
    status: 401,
    message: 'Run token is required or invalid.'
};

export function toNotFoundRejection(message: string): ControlHttpRejection {
    return { status: 404, message };
}

export function toBadRequestRejection(message: string): ControlHttpRejection {
    return { status: 400, message };
}

export function toForbiddenDestinationRejection(destinationIssues: readonly string[]): ControlHttpRejection {
    return { status: 403, message: destinationIssues.join('\n') };
}

export function toControlServiceRejection(failure: ControlServiceFailure): ControlHttpRejection {
    switch (failure.code) {
        case 'distributed-run-not-found':
            return { status: 404, message: failure.message };
        case 'distributed-run-terminal':
            return { status: 409, message: failure.message };
        case 'command-rate-limited':
            return { status: 429, message: failure.message };
        case 'command-kind-not-allowed':
        case 'command-payload-conflict':
        case 'distributed-run-exists':
            return toBadRequestRejection(failure.message);
    }
}

export function toRejected<TValue>(rejection: ControlHttpRejection): Either<ControlHttpRejection, TValue> {
    return Either.ofLeft(rejection);
}
