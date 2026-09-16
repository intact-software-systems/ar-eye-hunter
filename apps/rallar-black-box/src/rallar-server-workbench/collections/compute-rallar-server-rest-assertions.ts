import type {
    RallarServerRestAssertionResult,
    RallarServerRestCollectionExpectation,
    RallarServerRestCollectionValueExpectation,
    RallarServerRestCollectionVariables,
    RallarServerRestResponse
} from '../rallar-server-workbench-contracts.ts';
import { resolveRallarServerCollectionValue } from './resolve-rallar-server-collection-value.ts';
import { resolveRallarServerJsonPath } from './resolve-rallar-server-json-path.ts';
import { toLowerCaseRallarServerHeaders } from './to-lower-case-rallar-server-headers.ts';

export interface RallarServerRestAssertionInput {
    readonly response: RallarServerRestResponse;
    readonly expectation: RallarServerRestCollectionExpectation | undefined;
    readonly variables: RallarServerRestCollectionVariables;
}

interface ValueAssertionInput {
    readonly label: string;
    readonly actual: unknown;
    readonly expectation: RallarServerRestCollectionValueExpectation;
    readonly variables: RallarServerRestCollectionVariables;
}

export function computeRallarServerRestAssertions(
    { response, expectation, variables }: RallarServerRestAssertionInput
): readonly RallarServerRestAssertionResult[] {
    if (!expectation) {
        return [{ label: 'response ok', ok: response.ok, expected: true, actual: response.ok }];
    }
    const headers = toLowerCaseRallarServerHeaders(response.headers);
    const results = [
        ...toResponseAssertions(response, expectation),
        ...(expectation.body ?? []).flatMap((body) =>
            toValueAssertions({
                label: `body ${body.path}`,
                actual: resolveRallarServerJsonPath(response.bodyJson, body.path),
                expectation: body,
                variables
            })
        ),
        ...(expectation.headers ?? []).flatMap((header) =>
            toValueAssertions({
                label: `header ${header.name}`,
                actual: headers[header.name.toLowerCase()],
                expectation: header,
                variables
            })
        )
    ];
    return results.length > 0 ? results : [{ label: 'response captured', ok: true }];
}

function toResponseAssertions(
    response: RallarServerRestResponse,
    { ok, status }: RallarServerRestCollectionExpectation
): readonly RallarServerRestAssertionResult[] {
    const expectedStatuses = status === undefined ? undefined : Array.isArray(status) ? status : [status];
    return [
        ...(ok === undefined
            ? []
            : [{ label: 'response ok', ok: response.ok === ok, expected: ok, actual: response.ok }]),
        ...(expectedStatuses === undefined
            ? []
            : [{
                label: 'status',
                ok: expectedStatuses.includes(response.status),
                expected: expectedStatuses,
                actual: response.status
            }])
    ];
}

function toValueAssertions(
    { label, actual, expectation, variables }: ValueAssertionInput
): readonly RallarServerRestAssertionResult[] {
    const exists = actual !== undefined && actual !== null;
    const expected = resolveRallarServerCollectionValue(expectation.equals, variables);
    return [
        ...(expectation.exists === undefined
            ? []
            : [{
                label: `${label} exists`,
                ok: exists === expectation.exists,
                expected: expectation.exists,
                actual: exists
            }]),
        ...(Object.hasOwn(expectation, 'equals')
            ? [{
                label: `${label} equals`,
                ok: toComparableText(actual) === toComparableText(expected),
                expected,
                actual
            }]
            : []),
        ...(expectation.contains === undefined
            ? []
            : [{
                label: `${label} contains`,
                ok: toComparableText(actual).includes(expectation.contains),
                expected: expectation.contains,
                actual
            }])
    ];
}

function toComparableText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}
