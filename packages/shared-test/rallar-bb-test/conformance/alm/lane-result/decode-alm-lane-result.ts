import { isApiJsonObject, type ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    ALM_CONFORMANCE_TAGS,
    type AlmConformanceLaneFamily,
    type AlmConformanceTag
} from '../alm-conformance-scenario-definition.ts';
import {
    toField,
    validateList,
    validateMember,
    validateObject,
    validateText,
    validateUnique,
    type AlmLaneFileField
} from './alm-lane-file-field.ts';
import {
    ALM_LANE_BACKENDS,
    ALM_LANE_FAMILY_OUTCOMES,
    ALM_LANE_SCENARIO_OUTCOMES,
    type AlmLaneBackend,
    type AlmLaneFamilyOutcome,
    type AlmLaneFamilyResult,
    type AlmLanePlannedFamily,
    type AlmLanePlanRecord,
    type AlmLaneRunIdentity,
    type AlmLaneScenarioOutcome,
    type AlmLaneScenarioResult
} from './alm-lane-result.ts';

/**
 * A file read back from an artifact. Every issue names the field's path and what was there; an unknown extra field
 * is ignored and dropped. A scenario key named twice is an issue, since a ledger keyed by scenario cannot hold both.
 */
export function decodeAlmLaneFamilyResult(value: unknown): Either<readonly string[], AlmLaneFamilyResult> {
    return decodeRecordRoot(value, 'A family result').flatMap((issues) => Either.ofLeft(issues), decodeFamilyResult);
}

/** As a family result; a family planned twice, or a scenario key planned twice in one family, is an issue. */
export function decodeAlmLanePlanRecord(value: unknown): Either<readonly string[], AlmLanePlanRecord> {
    return decodeRecordRoot(value, 'A plan record').flatMap((issues) => Either.ofLeft(issues), decodePlanRecord);
}

function decodeRecordRoot(value: unknown, recordName: string): Either<readonly string[], ApiJsonObject> {
    if (isApiJsonObject(value)) {
        return Either.ofRight(value);
    }
    const received = Array.isArray(value) ? 'an array' : String(JSON.stringify(value));
    return Either.ofLeft([`${recordName} must be an object; received ${received}.`]);
}

function decodeFamilyResult(value: ApiJsonObject): Either<readonly string[], AlmLaneFamilyResult> {
    const issues = [
        ...validateRunIdentity(value),
        ...validateMember(toField(value, 'family'), ALM_CONFORMANCE_LANE_FAMILIES),
        ...validateMember(toField(value, 'familyOutcome'), ALM_LANE_FAMILY_OUTCOMES),
        ...validateList(toField(value, 'scenarios'), validateScenario),
        ...validateUnique(toField(value, 'scenarios'), 'scenarioKey')
    ];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        ...toRunIdentity(value),
        family: value.family as AlmConformanceLaneFamily,
        familyOutcome: value.familyOutcome as AlmLaneFamilyOutcome,
        scenarios: (value.scenarios as readonly ApiJsonObject[]).map((scenario): AlmLaneScenarioResult => ({
            scenarioKey: scenario.scenarioKey as string,
            outcome: scenario.outcome as AlmLaneScenarioOutcome
        }))
    });
}

function decodePlanRecord(value: ApiJsonObject): Either<readonly string[], AlmLanePlanRecord> {
    const issues = [
        ...validateRunIdentity(value),
        ...validateList(toField(value, 'families'), validatePlannedFamily),
        ...validateUnique(toField(value, 'families'), 'family')
    ];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        ...toRunIdentity(value),
        families: (value.families as readonly ApiJsonObject[]).map((planned): AlmLanePlannedFamily => ({
            family: planned.family as AlmConformanceLaneFamily,
            scenarioKeys: planned.scenarioKeys as readonly string[]
        }))
    });
}

function validateRunIdentity(record: ApiJsonObject): readonly string[] {
    return [
        ...validateMember(toField(record, 'carrier'), ALM_CONFORMANCE_CARRIERS),
        ...validateMember(toField(record, 'scope'), ALM_CONFORMANCE_TAGS),
        ...validateMember(toField(record, 'backend'), ALM_LANE_BACKENDS)
    ];
}

/** Only after `validateRunIdentity` found no issue. */
function toRunIdentity(record: ApiJsonObject): AlmLaneRunIdentity {
    return {
        carrier: record.carrier as AlmConformanceCarrier,
        scope: record.scope as AlmConformanceTag,
        backend: record.backend as AlmLaneBackend
    };
}

function validateScenario(field: AlmLaneFileField): readonly string[] {
    return validateObject(field, (scenario) => [
        ...validateText(toField(scenario, 'scenarioKey', field.path)),
        ...validateMember(toField(scenario, 'outcome', field.path), ALM_LANE_SCENARIO_OUTCOMES)
    ]);
}

function validatePlannedFamily(field: AlmLaneFileField): readonly string[] {
    return validateObject(field, (planned) => [
        ...validateMember(toField(planned, 'family', field.path), ALM_CONFORMANCE_LANE_FAMILIES),
        ...validateList(toField(planned, 'scenarioKeys', field.path), validateText),
        ...validateUnique(toField(planned, 'scenarioKeys', field.path), undefined)
    ]);
}
