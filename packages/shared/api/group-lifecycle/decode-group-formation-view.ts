import { Either } from '../../resilience/Either.ts';
import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import { isSameGroupRef } from '../api-type-utils.ts';
import type { PendingTopologyReplan } from '../graph-topology-management-types.ts';
import type { GroupRef } from '../group-types.ts';
import { validateRallarGroupRef, validateRallarNonNegativeInteger } from '../rallar-validation.ts';
import {
    GROUP_ACTIVATION_CONDITIONS,
    GROUP_ACTIVATION_REMEDIATIONS,
    type GroupActivationCondition,
    type GroupActivationRemediation
} from './activation-status/compute-group-activation-condition.ts';
import type { GroupFormationReadiness } from './activation-status/compute-group-formation-reading.ts';
import type { GroupFormationView } from './group-formation-view.ts';
import { isGroupLayoutIdentity } from './group-layout-identity.ts';
import {
    GROUP_FORMATION_OUTCOME_KINDS,
    GROUP_LIFECYCLE_STATES,
    type GroupFormationOutcome,
    type GroupLifecycleState
} from './group-lifecycle-policy.ts';

export interface GroupFormationViewIssue {
    readonly path: keyof GroupFormationView | '$';
    readonly code: 'missing-field' | 'invalid-value';
    readonly message: string;
}

interface GroupFormationViewFieldCheck {
    readonly message: string;
    readonly isValid: (value: ApiJsonValue) => boolean;
}

/** Every field the view declares; leaving one out does not compile. */
const FIELD_CHECKS = {
    groupRef: { message: 'Group ref must name a routable group', isValid: isGroupRefValue },
    lifecycleState: { message: 'Unknown lifecycle state', isValid: isLifecycleState },
    formationEpoch: { message: 'Formation epoch must be a non-negative integer', isValid: isNonNegativeInteger },
    formationAttemptCount: {
        message: 'Formation attempt count must be a non-negative integer',
        isValid: isNonNegativeInteger
    },
    lastFormationOutcome: {
        message: 'Last formation outcome must be null or a recorded decision',
        isValid: isNullOr(isFormationOutcome)
    },
    establishmentStartedAtEpochMs: {
        message: 'Establishment start must be null or a non-negative integer',
        isValid: isNullOr(isNonNegativeInteger)
    },
    readiness: {
        message: 'Readiness must carry the planned and observed edge counts and a unit-fraction observed rate',
        isValid: isReadiness
    },
    managerPrincipalIds: { message: 'Manager principal ids must be strings', isValid: isStringList },
    layoutStale: { message: 'layoutStale must be a boolean', isValid: isBoolean },
    pending: {
        message: 'Pending replan must be null or the queued replan',
        isValid: isNullOr(isPendingTopologyReplan)
    },
    maxFormationAttempts: {
        message: 'Attempt budget must be null or a positive integer',
        isValid: isNullOr(isPositiveInteger)
    },
    condition: { message: 'Unknown activation condition', isValid: isActivationCondition },
    remediation: { message: 'Unknown remediation', isValid: isActivationRemediation },
    coverageBasisLayoutIdentity: {
        message: 'Coverage basis must be null or a layout identity',
        isValid: isNullOr(isGroupLayoutIdentity)
    }
} satisfies Record<keyof GroupFormationView, GroupFormationViewFieldCheck>;

const FIELDS = Object.keys(FIELD_CHECKS) as ReadonlyArray<keyof typeof FIELD_CHECKS>;

/**
 * Checks the claims a decoded formation view makes before the browser trusts
 * it: every issue at once, a missing field reported once rather than also as
 * an invalid value, and the group identity once the ref itself is well formed.
 */
export function decodeGroupFormationView(
    value: unknown,
    expectedGroupRef: GroupRef
): Either<readonly GroupFormationViewIssue[], GroupFormationView> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return Either.ofLeft([{ path: '$', code: 'invalid-value', message: 'Formation view must be an object' }]);
    }
    const record = value as Partial<Record<keyof GroupFormationView, ApiJsonValue>>;
    const groupRef = record.groupRef;
    const issues = [
        ...FIELDS.flatMap((field) => toFieldIssues(field, record[field])),
        ...(isGroupRefValue(groupRef) && !isSameGroupRef(groupRef, expectedGroupRef)
            ? [{ path: 'groupRef', code: 'invalid-value', message: 'Formation view names a different group' } as const]
            : [])
    ];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(value as GroupFormationView);
}

function toFieldIssues(
    field: keyof GroupFormationView,
    fieldValue: ApiJsonValue | undefined
): readonly GroupFormationViewIssue[] {
    if (fieldValue === undefined) {
        return [{ path: field, code: 'missing-field', message: `Formation view is missing ${field}` }];
    }
    return FIELD_CHECKS[field].isValid(fieldValue)
        ? []
        : [{ path: field, code: 'invalid-value', message: FIELD_CHECKS[field].message }];
}

function isNullOr(isValue: (value: ApiJsonValue) => boolean): (value: ApiJsonValue) => boolean {
    return (value) => value === null || isValue(value);
}

function isRecordValue(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGroupRefValue(value: unknown): value is GroupRef {
    return validateRallarGroupRef(value).ok;
}

function isLifecycleState(value: unknown): value is GroupLifecycleState {
    return typeof value === 'string' && GROUP_LIFECYCLE_STATES.some((state) => state === value);
}

function isActivationCondition(value: unknown): value is GroupActivationCondition {
    return typeof value === 'string' && GROUP_ACTIVATION_CONDITIONS.some((condition) => condition === value);
}

function isActivationRemediation(value: unknown): value is GroupActivationRemediation {
    return typeof value === 'string' && GROUP_ACTIVATION_REMEDIATIONS.some((remediation) => remediation === value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return validateRallarNonNegativeInteger(value).ok;
}

function isPositiveInteger(value: unknown): value is number {
    return isNonNegativeInteger(value) && value >= 1;
}

function isUnitFraction(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function isStringList(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFormationOutcome(value: unknown): value is GroupFormationOutcome {
    return isRecordValue(value) &&
        typeof value.outcome === 'string' &&
        GROUP_FORMATION_OUTCOME_KINDS.some((kind) => kind === value.outcome) &&
        isUnitFraction(value.observedRate) &&
        isNonNegativeInteger(value.atEpochMs) &&
        isNonNegativeInteger(value.formationEpoch);
}

function isReadiness(value: unknown): value is GroupFormationReadiness {
    return isRecordValue(value) &&
        isNonNegativeInteger(value.plannedEdgeCount) &&
        isNonNegativeInteger(value.observedEdgeCount) &&
        isUnitFraction(value.observedRate);
}

function isPendingTopologyReplan(value: unknown): value is PendingTopologyReplan {
    return isRecordValue(value) &&
        typeof value.reconfigureQueued === 'boolean' &&
        (value.dueAtEpochMs === null || isNonNegativeInteger(value.dueAtEpochMs)) &&
        (value.generation === null || isNonNegativeInteger(value.generation));
}
