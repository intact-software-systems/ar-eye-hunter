import { requireExactKeys, requireRecord, requireString } from './exact-object-decoding.ts';
import { assertValidRallarRouteId } from './rallar-validation.ts';
import type { StateScope } from './state-types.ts';

export function decodeStateScope(value: unknown): StateScope {
    const scope = requireRecord(value, 'State scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'State scope');
    requireString(scope.applicationId, 'State application');
    requireString(scope.workspaceId, 'State workspace');
    return {
        applicationId: assertValidRallarRouteId(scope.applicationId),
        workspaceId: assertValidRallarRouteId(scope.workspaceId)
    };
}
