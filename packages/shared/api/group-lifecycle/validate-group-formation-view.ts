import { isSameGroupRef } from '../api-type-utils.ts';
import type { GroupRef } from '../group-types.ts';
import {
    GROUP_ACTIVATION_CONDITIONS,
    type GroupActivationRemediation
} from './activation-status/compute-group-activation-condition.ts';
import type { GroupFormationReadiness } from './activation-status/compute-group-formation-reading.ts';
import type { GroupFormationView } from './group-formation-view.ts';
import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES,
    type GroupLayoutIdentity
} from './group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES } from './group-lifecycle-policy.ts';

export interface GroupFormationViewIssue {
    readonly path: string;
    readonly code: 'missing-field' | 'invalid-value';
    readonly message: string;
}

export const GROUP_ACTIVATION_REMEDIATIONS = [
    'none',
    'replan-queued',
    'awaiting-application'
] as const satisfies readonly GroupActivationRemediation[];

interface GroupFormationViewFieldCheck {
    readonly path: keyof GroupFormationView;
    readonly message: string;
    readonly isValid: (view: GroupFormationView, expectedGroupRef: GroupRef) => boolean;
}

const REQUIRED_KEYS = [
    'groupRef',
    'lifecycleState',
    'formationEpoch',
    'formationAttemptCount',
    'lastFormationOutcome',
    'establishmentStartedAtEpochMs',
    'readiness',
    'managerPrincipalIds',
    'layoutStale',
    'pending',
    'maxFormationAttempts',
    'condition',
    'remediation',
    'coverageBasisLayoutIdentity'
] as const satisfies readonly (keyof GroupFormationView)[];

const FIELD_CHECKS: readonly GroupFormationViewFieldCheck[] = [
    {
        path: 'groupRef',
        message: 'Formation view names a different group',
        isValid: (view, expectedGroupRef) =>
            isGroupRefValue(view.groupRef) && isSameGroupRef(view.groupRef, expectedGroupRef)
    },
    {
        path: 'lifecycleState',
        message: 'Unknown lifecycle state',
        isValid: (view) => GROUP_LIFECYCLE_STATES.includes(view.lifecycleState)
    },
    {
        path: 'condition',
        message: 'Unknown activation condition',
        isValid: (view) => GROUP_ACTIVATION_CONDITIONS.includes(view.condition)
    },
    {
        path: 'remediation',
        message: 'Unknown remediation',
        isValid: (view) => GROUP_ACTIVATION_REMEDIATIONS.includes(view.remediation)
    },
    {
        path: 'formationEpoch',
        message: 'Formation epoch must be a non-negative integer',
        isValid: (view) => isNonNegativeInteger(view.formationEpoch)
    },
    {
        path: 'formationAttemptCount',
        message: 'Formation attempt count must be a non-negative integer',
        isValid: (view) => isNonNegativeInteger(view.formationAttemptCount)
    },
    {
        path: 'readiness',
        message: 'Readiness must carry the planned and observed edge counts and the observed rate',
        isValid: (view) => isReadiness(view.readiness)
    },
    {
        path: 'managerPrincipalIds',
        message: 'Manager principal ids must be strings',
        isValid: (view) =>
            Array.isArray(view.managerPrincipalIds) &&
            view.managerPrincipalIds.every((id) => typeof id === 'string')
    },
    {
        path: 'layoutStale',
        message: 'layoutStale must be a boolean',
        isValid: (view) => typeof view.layoutStale === 'boolean'
    },
    {
        path: 'maxFormationAttempts',
        message: 'Attempt budget must be null or a non-negative integer',
        isValid: (view) => view.maxFormationAttempts === null || isNonNegativeInteger(view.maxFormationAttempts)
    },
    {
        path: 'coverageBasisLayoutIdentity',
        message: 'Coverage basis must be null or a layout identity',
        isValid: (view) =>
            view.coverageBasisLayoutIdentity === null || isLayoutIdentity(view.coverageBasisLayoutIdentity)
    }
];

/**
 * Checks the claims a decoded formation view makes before the browser trusts
 * it: every issue at once, and a missing field reported once rather than also
 * as an invalid value.
 */
export function validateGroupFormationView(
    view: GroupFormationView,
    expectedGroupRef: GroupRef
): readonly GroupFormationViewIssue[] {
    if (typeof view !== 'object' || view === null) {
        return [{ path: '$', code: 'invalid-value', message: 'Formation view must be an object' }];
    }
    const missing = REQUIRED_KEYS
        .filter((key) => !(key in view))
        .map((key): GroupFormationViewIssue => ({
            path: key,
            code: 'missing-field',
            message: `Formation view is missing ${key}`
        }));
    const invalid = FIELD_CHECKS
        .filter((check) => check.path in view && !check.isValid(view, expectedGroupRef))
        .map((check): GroupFormationViewIssue => ({ path: check.path, code: 'invalid-value', message: check.message }));
    return [...missing, ...invalid];
}

function isGroupRefValue(groupRef: GroupRef): boolean {
    return typeof groupRef === 'object' &&
        groupRef !== null &&
        typeof groupRef.applicationId === 'string' &&
        typeof groupRef.groupId === 'string' &&
        (groupRef.workspaceId === undefined || typeof groupRef.workspaceId === 'string');
}

function isNonNegativeInteger(value: number): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isReadiness(readiness: GroupFormationReadiness): boolean {
    return typeof readiness === 'object' &&
        readiness !== null &&
        isNonNegativeInteger(readiness.plannedEdgeCount) &&
        isNonNegativeInteger(readiness.observedEdgeCount) &&
        typeof readiness.observedRate === 'number';
}

function isLayoutIdentity(identity: GroupLayoutIdentity): boolean {
    return typeof identity === 'object' &&
        identity !== null &&
        GROUP_LAYOUT_IDENTITY_KEYS.every((key) => key in identity) &&
        isNonNegativeInteger(identity.groupRevision) &&
        isNonNegativeInteger(identity.presenceRevision) &&
        isNonNegativeInteger(identity.version) &&
        GROUP_LAYOUT_IDENTITY_STATES.includes(identity.state);
}
