import type { Either } from '@shared/resilience/Either.ts';
import type { RallarServerRestRequestInput } from './rallar-server-workbench-contracts.ts';
import { redactRallarServerText, redactRallarServerUrl } from './redact-rallar-server-value.ts';
import { toRallarServerRestRequest } from './to-rallar-server-rest-request.ts';

export function toRallarServerCurl(input: RallarServerRestRequestInput): Either<string, string> {
    return toRallarServerRestRequest(input).mapRight((request) =>
        [
            'curl',
            '-X',
            request.method,
            toShellQuoted(redactRallarServerUrl(request.url, input.authSession)),
            ...Object.entries(request.redactedHeaders).flatMap((
                [key, value]
            ) => ['-H', toShellQuoted(`${key}: ${value}`)]),
            ...(request.bodyText
                ? ['--data', toShellQuoted(redactRallarServerText(request.bodyText, input.authSession))]
                : [])
        ].join(' ')
    );
}

function toShellQuoted(value: string): string {
    return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}
