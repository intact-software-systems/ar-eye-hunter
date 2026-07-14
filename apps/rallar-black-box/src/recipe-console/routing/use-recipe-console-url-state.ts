import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveAppExperience } from '../../app/experience-route.ts';
import {
    createRecipeConsoleUrlHistory,
    type RecipeConsoleHistoryPort,
} from './url-history.ts';
import {
    createRecipeConsoleShareHref,
    scrubRecipeConsoleHash,
} from './url-state-codec.ts';
import type {
    ParsedRecipeConsoleUrl,
    RecipeConsoleUrlState,
} from './url-state-contract.ts';

function writeBrowserSearch(method: 'pushState' | 'replaceState', search: string): void {
    const url = new URL(window.location.href);
    url.search = search;
    url.hash = scrubRecipeConsoleHash(url.hash);
    window.history[method](null, '', url);
}

function createBrowserPort(): RecipeConsoleHistoryPort {
    return {
        readSearch: () => window.location.search,
        push: search => writeBrowserSearch('pushState', search),
        replace: search => writeBrowserSearch('replaceState', search),
        subscribe: listener => {
            window.addEventListener('popstate', listener);
            return () => window.removeEventListener('popstate', listener);
        },
    };
}

function replaceNonCanonicalBrowserUrl(value: ParsedRecipeConsoleUrl): void {
    if (resolveAppExperience(window.location.search) !== 'recipe-console') {
        return;
    }
    const canonicalHash = scrubRecipeConsoleHash(window.location.hash);
    if (
        window.location.search === value.canonicalSearch &&
        window.location.hash === canonicalHash
    ) {
        return;
    }
    writeBrowserSearch('replaceState', value.canonicalSearch);
}

export function useRecipeConsoleUrlState() {
    const history = useMemo(
        () => createRecipeConsoleUrlHistory(createBrowserPort()),
        [],
    );
    const [value, setValue] = useState(history.read);

    useEffect(() => {
        replaceNonCanonicalBrowserUrl(history.read());
        return history.subscribe(next => {
            replaceNonCanonicalBrowserUrl(next);
            setValue(next);
        });
    }, [history]);

    const navigate = useCallback((patch: Partial<RecipeConsoleUrlState>): void => {
        setValue(history.push(patch));
    }, [history]);
    const replace = useCallback((patch: Partial<RecipeConsoleUrlState>): void => {
        const next = history.replace(patch);
        setValue(previous => ({
            ...next,
            issues: previous.issues,
        }));
    }, [history]);
    const copyHref = createRecipeConsoleShareHref(window.location, value.state);

    return {
        state: value.state,
        issues: value.issues,
        navigate,
        replace,
        copyHref,
    } as const;
}
