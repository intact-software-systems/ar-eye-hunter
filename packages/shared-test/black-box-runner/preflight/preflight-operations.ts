import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import {
    toFiniteNumber,
    toNonEmptyText,
    toPreflightJsonArray,
    toPreflightJsonObject
} from './preflight-json-values.ts';

export const PREFLIGHT_TRANSPORT_KEYS = [
    'HTTP',
    'MQ',
    'WS',
    'RTC',
    'WEBRTC',
    'CRDT',
    'ASSERT',
    'SET',
    'PARALLEL'
] as const;

export type BlackBoxRunnerPreflightTransportKey = typeof PREFLIGHT_TRANSPORT_KEYS[number];

export interface BlackBoxRunnerPreflightStepOperation {
    readonly name: string;
    readonly transport: Exclude<BlackBoxRunnerPreflightTransportKey, 'PARALLEL'> | 'UNKNOWN';
    /** Absent when the step's request sets no action. */
    readonly action?: string;
    /** Absent when the step's request names no connection. */
    readonly connection?: string;
    /** Absent when the step names no provider. */
    readonly provider?: string;
    /** Absent when the step's request sets neither path nor url. */
    readonly path?: string;
    /** Absent when the step is not inside a named parallel group. */
    readonly group?: string;
    /** Absent when the expanded step carries no numeric execution number. */
    readonly interactionExecutionNumber?: number;
    /** Absent when the expanded step carries no numeric repeat index. */
    readonly repeatIndex?: number;
}

export interface BlackBoxRunnerPreflightParallelOperation
    extends Omit<BlackBoxRunnerPreflightStepOperation, 'transport'> {
    readonly transport: 'PARALLEL';
    readonly groupCount: number;
}

export type BlackBoxRunnerPreflightOperation =
    | BlackBoxRunnerPreflightStepOperation
    | BlackBoxRunnerPreflightParallelOperation;

/** Lists each executable step, followed by the steps of every group of a parallel step. */
export function toPreflightOperations(
    interactions: readonly ApiJsonValue[],
    group: string | undefined
): readonly BlackBoxRunnerPreflightOperation[] {
    return interactions.flatMap((interaction) => {
        const name = resolveInteractionName(interaction);
        const transport = resolveTransportKey(interaction) ?? 'UNKNOWN';
        const request = resolveExecutableRequest(interaction);
        if (transport !== 'PARALLEL') {
            return [{ name, transport, ...toOperationFields(request, group) }];
        }
        const groups = toPreflightJsonArray(request.groups);
        const children = groups.flatMap((groupSpec) => {
            const groupRecord = toPreflightJsonObject(groupSpec);
            return toPreflightOperations(toPreflightJsonArray(groupRecord.steps), toNonEmptyText(groupRecord.name));
        });
        return [{ name, transport, ...toOperationFields(request, group), groupCount: groups.length }, ...children];
    });
}

export function resolveTransportKey(interaction: ApiJsonValue): BlackBoxRunnerPreflightTransportKey | undefined {
    const record = toPreflightJsonObject(interaction);
    return PREFLIGHT_TRANSPORT_KEYS.find((key) => record[key] !== undefined);
}

export function resolveExecutableRequest(interaction: ApiJsonValue): ApiJsonObject {
    const key = resolveTransportKey(interaction);
    return key ? toPreflightJsonObject(toPreflightJsonObject(toPreflightJsonObject(interaction)[key]).request) : {};
}

function resolveInteractionName(interaction: ApiJsonValue): string {
    return Object.keys(toPreflightJsonObject(interaction))
        .find((key) => !PREFLIGHT_TRANSPORT_KEYS.some((transport) => transport === key)) ?? 'unnamed';
}

function toOperationFields(
    request: ApiJsonObject,
    group: string | undefined
): Omit<BlackBoxRunnerPreflightStepOperation, 'name' | 'transport'> {
    return {
        action: toNonEmptyText(request.action),
        connection: toNonEmptyText(request.connection),
        provider: toNonEmptyText(request.provider),
        path: toNonEmptyText(request.path ?? request.url),
        group,
        interactionExecutionNumber: toFiniteNumber(request.interactionExecutionNumber),
        repeatIndex: toFiniteNumber(request.repeatIndex)
    };
}
