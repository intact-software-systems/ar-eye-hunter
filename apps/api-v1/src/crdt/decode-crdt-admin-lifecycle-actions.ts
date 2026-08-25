import type { CrdtLifecycleFieldAction } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { decodeExactProjectionIds } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-projection-ids.ts';
import { decodeExactQuotaPolicy } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-quota-policy.ts';
import { decodeExactRetentionPolicy } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-retention-policy.ts';
import type { RallarCrdtQuotaPolicy, RallarCrdtRetentionPolicy } from '@shared/crdt/mod.ts';

import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

export interface CrdtAdminLifecycleActions {
    readonly retentionAction: CrdtLifecycleFieldAction<RallarCrdtRetentionPolicy>;
    readonly quotaAction: CrdtLifecycleFieldAction<RallarCrdtQuotaPolicy>;
    readonly projectionIdsAction: CrdtLifecycleFieldAction<readonly string[]>;
}

export function decodeCrdtAdminLifecycleActions(
    request: JsonWireObject
): CrdtAdminLifecycleActions {
    const retentionAction = decodeCrdtAdminLifecycleActionValue(request, 'retention');
    const quotaAction = decodeCrdtAdminLifecycleActionValue(request, 'quota');
    const projectionIdsAction = decodeCrdtAdminLifecycleActionValue(request, 'projectionIds');
    return {
        retentionAction: retentionAction.kind === 'set'
            ? { kind: retentionAction.kind, value: decodeExactRetentionPolicy(retentionAction.value) }
            : retentionAction,
        quotaAction: quotaAction.kind === 'set'
            ? { kind: quotaAction.kind, value: decodeExactQuotaPolicy(quotaAction.value) }
            : quotaAction,
        projectionIdsAction: projectionIdsAction.kind === 'set'
            ? { kind: projectionIdsAction.kind, value: decodeExactProjectionIds(projectionIdsAction.value) }
            : projectionIdsAction
    };
}

function decodeCrdtAdminLifecycleActionValue(
    request: JsonWireObject,
    key: 'retention' | 'quota' | 'projectionIds'
): CrdtLifecycleFieldAction<JsonWireValue> {
    if (!(key in request)) {
        return { kind: 'preserve' };
    }
    const value = request[key];
    return value === null ? { kind: 'clear' } : { kind: 'set', value };
}
