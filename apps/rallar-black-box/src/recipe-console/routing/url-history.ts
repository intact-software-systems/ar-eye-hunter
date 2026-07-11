import {
    RECIPE_CONSOLE_URL_VERSION,
    type ParsedRecipeConsoleUrl,
    type RecipeConsoleUrlState,
} from './url-state-contract.ts';
import {
    parseRecipeConsoleUrl,
    serializeRecipeConsoleUrl,
} from './url-state-codec.ts';

export type RecipeConsoleHistoryPort = Readonly<{
    readSearch(): string;
    push(search: string): void;
    replace(search: string): void;
    subscribe(listener: () => void): () => void;
}>;

export function createRecipeConsoleUrlHistory(
    port: RecipeConsoleHistoryPort,
): Readonly<{
    read(): ParsedRecipeConsoleUrl;
    push(patch: Partial<RecipeConsoleUrlState>): ParsedRecipeConsoleUrl;
    replace(patch: Partial<RecipeConsoleUrlState>): ParsedRecipeConsoleUrl;
    subscribe(listener: (value: ParsedRecipeConsoleUrl) => void): () => void;
}> {
    const read = (): ParsedRecipeConsoleUrl =>
        parseRecipeConsoleUrl(port.readSearch());

    const write = (
        method: 'push' | 'replace',
        patch: Partial<RecipeConsoleUrlState>,
    ): ParsedRecipeConsoleUrl => {
        const current = read();
        const state: RecipeConsoleUrlState = {
            ...current.state,
            ...patch,
            v: RECIPE_CONSOLE_URL_VERSION,
            experience: 'recipe-console',
        };
        const search = serializeRecipeConsoleUrl(state, port.readSearch());
        port[method](search);
        return parseRecipeConsoleUrl(search);
    };

    return {
        read,
        push: patch => write('push', patch),
        replace: patch => write('replace', patch),
        subscribe: listener => port.subscribe(() => listener(read())),
    };
}
