import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import {
    fromCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch
} from '@shared/api/group-topology-config-canonical.ts';

export interface PutTopologyConfigBody {
    readonly requestId?: string;
    readonly config: GroupTopologyConfigPatch;
}

export interface PutTopologyOverrideBody extends PutTopologyConfigBody {
    readonly ttlMs?: number;
    readonly expiresAtEpochMs?: number;
}

export interface ReconfigureTopologyBody {
    readonly requestId?: string;
    readonly options?: GroupTopologyConfigPatch;
    readonly publish?: boolean;
}

export function decodePutTopologyConfigBody(value: JsonWireValue): PutTopologyConfigBody {
    const body = readTopologyRequestRecord(value, ['requestId', 'config']);
    return {
        ...readOptionalRequestId(body),
        config: decodeTopologyConfigPatch(body.config)
    };
}

export function decodePutTopologyOverrideBody(value: JsonWireValue): PutTopologyOverrideBody {
    const body = readTopologyRequestRecord(value, [
        'requestId',
        'config',
        'ttlMs',
        'expiresAtEpochMs'
    ]);
    const ttlMs = readOptionalFiniteNumber(body, 'ttlMs');
    const expiresAtEpochMs = readOptionalFiniteNumber(body, 'expiresAtEpochMs');
    return {
        ...readOptionalRequestId(body),
        config: decodeTopologyConfigPatch(body.config),
        ...(ttlMs === undefined ? {} : { ttlMs }),
        ...(expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs })
    };
}

export function decodeReconfigureTopologyBody(value: JsonWireValue): ReconfigureTopologyBody {
    const body = readTopologyRequestRecord(value, ['requestId', 'options', 'publish']);
    const publish = body.publish;
    if (publish !== undefined && typeof publish !== 'boolean') {
        throw new TypeError('Topology publish must be a boolean');
    }
    return {
        ...readOptionalRequestId(body),
        ...(body.options === undefined ? {} : { options: decodeTopologyConfigPatch(body.options) }),
        ...(publish === undefined ? {} : { publish })
    };
}

function decodeTopologyConfigPatch(value: JsonWireValue): GroupTopologyConfigPatch {
    return fromCanonicalGroupTopologyConfigPatch(toCanonicalGroupTopologyConfigPatch(value));
}

function readTopologyRequestRecord(
    value: JsonWireValue,
    allowedKeys: readonly string[]
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError('Topology request body must be an object');
    }
    const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unexpectedKeys.length > 0) {
        throw new TypeError(
            `Topology request body contains unknown fields: ${unexpectedKeys.join(', ')}`
        );
    }
    return value;
}

function readOptionalRequestId(body: JsonWireObject): Readonly<{ requestId?: string; }> {
    if (body.requestId === undefined) {
        return {};
    }
    if (typeof body.requestId !== 'string') {
        throw new TypeError('Topology requestId must be a string');
    }
    return { requestId: body.requestId };
}

function readOptionalFiniteNumber(
    body: JsonWireObject,
    key: 'ttlMs' | 'expiresAtEpochMs'
): number | undefined {
    const value = body[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Topology ${key} must be a finite number`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
