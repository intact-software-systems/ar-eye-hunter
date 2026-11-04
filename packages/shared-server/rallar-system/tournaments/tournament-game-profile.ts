import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';

export interface TournamentGameProfile {
    readonly scope: StateScope;
    readonly rulesId: string;
    readonly noShowGraceMs: number;
    readonly gameLifecycleTopic: string;
}

export function decodeTournamentGameProfile(value: unknown): TournamentGameProfile {
    const profile = requireRecord(value, 'Tournament game profile');
    requireExactKeys(profile, ['scope', 'rulesId', 'noShowGraceMs', 'gameLifecycleTopic'], 'Tournament game profile');
    requireEpoch(profile.noShowGraceMs, 'Tournament no-show grace');
    requireString(profile.gameLifecycleTopic, 'Tournament game start topic');
    if (profile.noShowGraceMs === 0 || !/^app:[a-z0-9-]+:[a-z0-9-]+$/u.test(profile.gameLifecycleTopic)) {
        throw new TypeError('Tournament profile policy or topic is invalid');
    }
    return {
        scope: decodeStateScope(profile.scope),
        rulesId: assertValidRallarRouteId(profile.rulesId),
        noShowGraceMs: profile.noShowGraceMs,
        gameLifecycleTopic: profile.gameLifecycleTopic
    };
}

export function decodeTournamentGameProfiles(value: unknown): readonly TournamentGameProfile[] {
    if (!Array.isArray(value) || value.length > 64) {
        throw new TypeError('At most 64 tournament profiles are supported');
    }
    const profiles = value.map(decodeTournamentGameProfile);
    const scopes = profiles.map((profile) => JSON.stringify(profile.scope));
    if (new Set(scopes).size !== scopes.length) {
        throw new TypeError('Tournament rules require one profile per scope');
    }
    return profiles;
}

/** A game owns its native rules and private delivery topic; deployments may tune the grace period. */
export function bindTournamentGameProfile(
    configured: readonly TournamentGameProfile[],
    owner: Omit<TournamentGameProfile, 'noShowGraceMs'>
): readonly TournamentGameProfile[] {
    const profiles = decodeTournamentGameProfiles(configured);
    const defaultProfile = decodeTournamentGameProfile({ ...owner, noShowGraceMs: 600000 });
    const existing = profiles.find((profile) =>
        profile.scope.applicationId === owner.scope.applicationId &&
        profile.scope.workspaceId === owner.scope.workspaceId
    );
    if (existing === undefined) {
        return decodeTournamentGameProfiles([...profiles, defaultProfile]);
    }
    if (existing.rulesId !== owner.rulesId || existing.gameLifecycleTopic !== owner.gameLifecycleTopic) {
        throw new TypeError('Tournament profile differs from its native game owner');
    }
    return profiles;
}
