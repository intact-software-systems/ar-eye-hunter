import type { RallarBlackBoxTestRecipe } from '../../rallar-black-box-test-contracts.ts';

import { isAlmConformanceRole, type AlmConformanceRole } from './alm-conformance-roles.ts';

const PRINCIPAL_PLACEHOLDER_PATTERN = /\{principal:([a-z-]+)\}/g;

/** The placeholder a step writes where a role's principal id belongs; recipe creation substitutes it. */
export function toPrincipalPlaceholder(role: AlmConformanceRole): string {
    return `{principal:${role}}`;
}

/**
 * Substitutes every `{principal:<role>}` in the recipe. A placeholder naming a role the map lacks, or no role, throws:
 * the caller asked for a cell whose principals it cannot name.
 */
export function resolveAlmConformancePrincipals(
    recipe: RallarBlackBoxTestRecipe,
    principalIdsByRole: Readonly<Partial<Record<AlmConformanceRole, string>>>
): RallarBlackBoxTestRecipe {
    const text = JSON.stringify(recipe);
    if (!text.includes('{principal:')) {
        return recipe;
    }
    const resolved = text.replace(PRINCIPAL_PLACEHOLDER_PATTERN, (placeholder, role: string) => {
        const principalId = isAlmConformanceRole(role) ? principalIdsByRole[role] : undefined;
        if (principalId === undefined) {
            throw new Error(`${recipe.recipeId} names ${placeholder}, which principalIdsByRole does not resolve.`);
        }
        return principalId;
    });
    if (resolved.includes('{principal:')) {
        throw new Error(`${recipe.recipeId} names a principal placeholder that is not {principal:<role>}.`);
    }
    return JSON.parse(resolved) as RallarBlackBoxTestRecipe;
}
