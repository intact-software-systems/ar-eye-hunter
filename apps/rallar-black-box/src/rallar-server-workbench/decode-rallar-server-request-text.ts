import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarServerRestRequestInput } from './rallar-server-workbench-contracts.ts';

export type RallarServerRequestText = Pick<
    RallarServerRestRequestInput,
    'method' | 'path' | 'headersText' | 'queryText' | 'bodyText'
>;

export interface RallarServerRequestFields {
    /** A relative path keeps its query; an absolute URL stays absolute. */
    readonly pathWithQuery: string;
    readonly headers: Readonly<Record<string, string>>;
    /** Absent for a GET or an empty body. */
    readonly body?: unknown;
}

const RELATIVE_URL_BASE = 'http://rallar-black-box.local';
const ABSOLUTE_URL = /^https?:\/\//i;

export function decodeRallarServerRequestText(
    text: RallarServerRequestText
): Either<string, RallarServerRequestFields> {
    return decodeJsonObjectText(text.queryText, 'Query JSON').flatMap(
        (error) => Either.ofLeft(error),
        (query) =>
            decodeHeadersText(text.headersText).flatMap(
                (error) => Either.ofLeft(error),
                (headers) =>
                    decodeRequestPath(text.path).flatMap(
                        (error) => Either.ofLeft(error),
                        (path) =>
                            decodeRequestBody(text).mapRight((body) => ({
                                pathWithQuery: toPathWithQuery(path, query),
                                headers,
                                ...body
                            }))
                    )
            )
    );
}

function decodeJsonText(text: string, label: string): Either<string, { readonly value?: unknown; }> {
    const trimmed = text.trim();
    if (!trimmed) {
        return Either.ofRight({});
    }
    try {
        return Either.ofRight({ value: JSON.parse(trimmed) });
    }
    catch (error) {
        return Either.ofLeft(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function decodeJsonObjectText(text: string, label: string): Either<string, Readonly<Record<string, unknown>>> {
    return decodeJsonText(text, label).flatMap(
        (error) => Either.ofLeft(error),
        ({ value }) => {
            if (value === undefined) {
                return Either.ofRight({});
            }
            return isJsonRecordValue(value) ? Either.ofRight(value) : Either.ofLeft(`${label} must be a JSON object.`);
        }
    );
}

function decodeHeadersText(text: string): Either<string, Readonly<Record<string, string>>> {
    return decodeJsonObjectText(text, 'Headers JSON').flatMap(
        (error) => Either.ofLeft(error),
        (record) => {
            const nonScalar = Object.entries(record).find(([, value]) =>
                value === undefined || value === null || typeof value === 'object'
            );
            return nonScalar
                ? Either.ofLeft(`Headers JSON value for ${nonScalar[0]} must be a scalar.`)
                : Either.ofRight(
                    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)]))
                );
        }
    );
}

function decodeRequestPath(path: string): Either<string, string> {
    const trimmed = path.trim();
    if (!trimmed) {
        return Either.ofLeft('Rallar Server request path is required.');
    }
    return Either.ofRight(ABSOLUTE_URL.test(trimmed) || trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
}

function decodeRequestBody(text: RallarServerRequestText): Either<string, Pick<RallarServerRequestFields, 'body'>> {
    if (text.bodyText.trim().length === 0 || text.method === 'GET') {
        return Either.ofRight({});
    }
    return decodeJsonText(text.bodyText, 'Body JSON').mapRight(({ value }) =>
        value === undefined ? {} : { body: value }
    );
}

function toPathWithQuery(path: string, query: Readonly<Record<string, unknown>>): string {
    const absolute = ABSOLUTE_URL.test(path);
    const url = absolute ? new URL(path) : new URL(path, RELATIVE_URL_BASE);
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => url.searchParams.append(key, String(item)));
            continue;
        }
        url.searchParams.set(key, String(value));
    }
    return absolute ? url.toString() : `${url.pathname}${url.search}`;
}
