import type { RallarBlackBoxTestHttpRequestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { decodeRallarServerRequestText } from './decode-rallar-server-request-text.ts';
import type { RallarServerRestRequestInput } from './rallar-server-workbench-contracts.ts';

export interface RallarServerBlackBoxCommandInput {
    readonly request: RallarServerRestRequestInput;
    readonly commandId: string;
}

export function toRallarServerBlackBoxCommand(
    { request, commandId }: RallarServerBlackBoxCommandInput
): Either<string, RallarBlackBoxTestHttpRequestCommand> {
    return decodeRallarServerRequestText(request).mapRight((fields) => ({
        kind: 'http.request',
        commandId,
        request: {
            path: fields.pathWithQuery,
            method: request.method,
            ...(Object.keys(fields.headers).length > 0 ? { headers: fields.headers } : {}),
            ...(fields.body === undefined ? {} : { body: fields.body })
        },
        response: {
            body: request.responseBodyMode === 'none' ? 'none' : request.responseBodyMode === 'text' ? 'text' : 'json'
        }
    }));
}
