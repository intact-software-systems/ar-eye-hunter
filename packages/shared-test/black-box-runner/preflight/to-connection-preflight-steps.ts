import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import { isJsonRecordValue } from '../../rallar-bb-test/schema/json-schema-validation.ts';
import { directSafeOutputTransformSpec } from '../scenario-transform/safe-output-transform.ts';
import {
    toNonEmptyText,
    toPreflightJsonArray,
    toPreflightJsonObject
} from './preflight-json-values.ts';
import {
    resolveExecutableRequest,
    resolveTransportKey
} from './preflight-operations.ts';
import type {
    ConnectionPreflightStep,
    ConnectionSelection
} from './to-connection-preflight.ts';

/**
 * A SET step may select which connection a later step uses, but only a selection that runs where failures stop the
 * run, and that no step overwrites wholesale, bounds the connections that can be reached.
 */
export function toConnectionPreflightSteps(
    interactions: readonly ApiJsonValue[],
    failureStops: boolean
): readonly ConnectionPreflightStep[] {
    return interactions.map((interaction) => {
        const request = resolveExecutableRequest(interaction);
        const transport = resolveTransportKey(interaction);
        const output = toNonEmptyText(request.output);
        const writtenOutputs = [...Object.keys(toPreflightJsonObject(request.outputs)), ...(output ? [output] : [])];
        const writesAllOutputs = writtenOutputs.some((name) => /[{}]/.test(name)) ||
            (request.outputs !== undefined && !isJsonRecordValue(request.outputs));
        const selectionCanBeTrusted = failureStops && isStoppingOnFailure(request) && !writesAllOutputs;
        const groups = transport === 'PARALLEL' ? toPreflightJsonArray(request.groups) : [];
        return {
            connection: toNonEmptyText(request.connection),
            writtenOutputs,
            writesAllOutputs,
            selection: transport === 'SET' && selectionCanBeTrusted ? toBoundedConnectionSelection(request) : undefined,
            groups: groups.map((group) =>
                toConnectionPreflightSteps(
                    toPreflightJsonArray(toPreflightJsonObject(group).steps),
                    isStoppingOnFailure(request)
                )
            )
        };
    });
}

export function isStoppingOnFailure(request: ApiJsonObject): boolean {
    return (request.failFast === undefined || request.failFast === true) &&
        (request.nonBlockingFailure === undefined || request.nonBlockingFailure === false);
}

function toBoundedConnectionSelection(request: ApiJsonObject): ConnectionSelection | undefined {
    const output = toNonEmptyText(request.output);
    if (!output || Object.hasOwn(toPreflightJsonObject(request.outputs), output)) {
        return undefined;
    }
    if (request.transform === undefined && request.outputPath) {
        return undefined;
    }
    const transform = toPreflightJsonObject(request.transform === undefined ? request.derive : request.transform);
    if (Object.keys(transform).length !== 1 || transform.if === undefined) {
        return undefined;
    }
    const branches = toPreflightJsonObject(transform.if);
    if (branches.condition === undefined) {
        return undefined;
    }
    const whenTrue = toLiteralConnection(toPreflightJsonObject(branches.then));
    const whenFalse = toLiteralConnection(toPreflightJsonObject(branches.else));
    return whenTrue && whenFalse ? { output, connections: [...new Set([whenTrue, whenFalse])] } : undefined;
}

function toLiteralConnection(branch: ApiJsonObject): string | undefined {
    if (directSafeOutputTransformSpec(branch) !== undefined) {
        return undefined;
    }
    const connection = branch.connection;
    return typeof connection === 'string' && connection.length > 0 && !/[{}]/.test(connection) ? connection : undefined;
}
