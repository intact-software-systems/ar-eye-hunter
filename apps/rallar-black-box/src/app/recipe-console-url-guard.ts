import {
    recipeConsoleControlCredentialPolicyFromSearch,
    type RecipeConsoleControlCredentialPolicy
} from '../recipe-console/control/control-credential-policy.ts';
import { scrubRecipeConsoleHash } from '../recipe-console/routing/url-state-codec.ts';
import { deleteSensitiveUrlKeys, toSearch } from '../recipe-console/routing/url-state-helpers.ts';
import { resolveAppExperience } from './experience-route.ts';

export function scrubRecipeConsoleHrefBeforeLoad(href: string): string {
    const url = new URL(href);
    if (resolveAppExperience(url.search) !== 'recipe-console') {
        return href;
    }

    const params = new URLSearchParams(url.search);
    deleteSensitiveUrlKeys(params);
    url.search = toSearch(params);
    url.hash = scrubRecipeConsoleHash(url.hash);
    return url.href;
}

export function scrubCurrentRecipeConsoleUrlBeforeLoad(): void {
    if (typeof window === 'undefined') {
        return;
    }
    const nextHref = scrubRecipeConsoleHrefBeforeLoad(window.location.href);
    if (nextHref === window.location.href) {
        return;
    }
    window.history.replaceState(
        window.history.state,
        document.title,
        nextHref
    );
}

export function captureInitialRecipeConsoleControlCredentialPolicy(): RecipeConsoleControlCredentialPolicy {
    const policy = recipeConsoleControlCredentialPolicyFromSearch(
        typeof window === 'undefined' ? '' : window.location.search
    );
    scrubCurrentRecipeConsoleUrlBeforeLoad();
    return policy;
}
