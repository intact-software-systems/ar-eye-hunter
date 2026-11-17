import { decodePlainRecord, hasExactKeys } from '@shared/api/exact-object-decoding.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { RALLAR_RTC_TOPOLOGY_KINDS } from '@shared/api/overlay-topology.ts';
import { getOwnCount, getOwnField } from '@shared/encoding/get-own-field.ts';
import { Either } from '@shared/resilience/Either.ts';

const EFFECTIVE_CONFIG_KEYS = ['topologyKind', 'degreeLimit', 'treeMinSize', 'meshMinSize', 'meshParamK'] as const;
const TOPOLOGY_KIND_SETTINGS = ['auto', ...RALLAR_RTC_TOPOLOGY_KINDS] as const;

/** Shape only: the server owns the value rules. */
export function decodeEffectiveGroupTopologyConfig(value: unknown): Either<string, EffectiveGroupTopologyConfig> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, EFFECTIVE_CONFIG_KEYS)) {
        return Either.ofLeft('The effective topology configuration must be an exact object with its own fields');
    }
    const topologyKind = TOPOLOGY_KIND_SETTINGS.find((kind) => kind === getOwnField(fields, 'topologyKind'));
    const degreeLimit = getOwnCount(fields, 'degreeLimit');
    const treeMinSize = getOwnCount(fields, 'treeMinSize');
    const meshMinSize = getOwnCount(fields, 'meshMinSize');
    const meshParamK = getOwnCount(fields, 'meshParamK');
    if (
        topologyKind === undefined || degreeLimit === null || treeMinSize === null || meshMinSize === null ||
        meshParamK === null
    ) {
        return Either.ofLeft('The effective topology configuration names no kind, or a size that is not a count');
    }
    return Either.ofRight({ topologyKind, degreeLimit, treeMinSize, meshMinSize, meshParamK });
}
