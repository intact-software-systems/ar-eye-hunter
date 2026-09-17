import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';

import {
    toRallarScopeDiagnostics,
    type RecipeRallarScopeFields
} from '../recipes/recipe-rallar-scope.ts';
import { decodeScenarioText } from '../scenario-value-decoding.ts';

export interface RemoteBrowserScopeFields extends RecipeRallarScopeFields {
    /** Absent when neither the step nor its rallar options set a minimum snapshot version. */
    readonly minSnapshotVersion?: number;
}

const SCOPE_IDENTIFIER_KEYS = ['applicationId', 'workspaceId', 'roomId', 'groupId'];

/** Scope identifiers set anywhere on the step must be scalars; the minimum snapshot version must be a finite number. */
export function toRallarScopeFields(request: ApiJsonObject): Either<Error, RemoteBrowserScopeFields> {
    if (request.rallar !== undefined && !isApiJsonObject(request.rallar)) {
        return Either.ofLeft(new Error('Rallar options must be an object.'));
    }
    const rallar = isApiJsonObject(request.rallar) ? request.rallar : {};
    const minSnapshotVersion = request.minSnapshotVersion !== undefined
        ? request.minSnapshotVersion
        : rallar.minSnapshotVersion;
    if (
        minSnapshotVersion !== undefined &&
        (typeof minSnapshotVersion !== 'number' || !Number.isFinite(minSnapshotVersion))
    ) {
        return Either.ofLeft(new Error('minSnapshotVersion must be a finite number.'));
    }
    for (const source of [request, rallar, request.scope, rallar.scope, request.roomRef, rallar.roomRef]) {
        if (source === undefined) {
            continue;
        }
        if (!isApiJsonObject(source)) {
            return Either.ofLeft(new Error('Rallar scope must be an object.'));
        }
        const invalidKey = SCOPE_IDENTIFIER_KEYS.find((key) =>
            source[key] !== undefined && decodeScenarioText(source[key]) === undefined
        );
        if (invalidKey !== undefined) {
            return Either.ofLeft(new Error(`Rallar scope ${invalidKey} must be a scalar identifier.`));
        }
    }
    return Either.ofRight({
        ...toRallarScopeDiagnostics(request),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    });
}

function isApiJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
