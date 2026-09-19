import { Either } from '@shared/resilience/Either.ts';
import { decodeRallarServerRequestText, type RallarServerRequestFields } from './decode-rallar-server-request-text.ts';
import type { RallarServerRestRequest, RallarServerRestRequestInput } from './rallar-server-workbench-contracts.ts';
import { redactRallarServerValue } from './redact-rallar-server-value.ts';
import { toRallarServerBaseUrl } from './to-rallar-server-base-url.ts';

export function toRallarServerRestRequest(
    input: RallarServerRestRequestInput
): Either<string, RallarServerRestRequest> {
    return toRallarServerBaseUrl(input).flatMap(
        (error) => Either.ofLeft(error),
        (baseUrl) =>
            decodeRallarServerRequestText(input).flatMap(
                (error) => Either.ofLeft(error),
                (fields) =>
                    toRequestHeaders(input, fields).mapRight((headers) => ({
                        url: new URL(fields.pathWithQuery, baseUrl).toString(),
                        method: input.method,
                        headers,
                        bodyText: toBodyText(fields),
                        redactedHeaders: redactRallarServerValue(headers, input.authSession)
                    }))
            )
    );
}

function toRequestHeaders(
    { attachAuth, authSession }: RallarServerRestRequestInput,
    fields: RallarServerRequestFields
): Either<string, Readonly<Record<string, string>>> {
    const hasContentType = Object.keys(fields.headers).some((key) => key.toLowerCase() === 'content-type');
    const headers: Readonly<Record<string, string>> = {
        accept: 'application/json',
        ...fields.headers,
        ...(fields.body !== undefined && !hasContentType ? { 'content-type': 'application/json' } : {})
    };
    if (!attachAuth) {
        return Either.ofRight(headers);
    }
    return authSession
        ? Either.ofRight({
            ...headers,
            authorization: `Bearer ${authSession.accessToken}`,
            'x-client-id': authSession.clientId
        })
        : Either.ofLeft('Rallar Server request requires a browser auth session.');
}

function toBodyText({ body }: RallarServerRequestFields): string | undefined {
    if (body === undefined) {
        return undefined;
    }
    return typeof body === 'string' ? body : JSON.stringify(body);
}
