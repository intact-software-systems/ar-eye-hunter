import type { RallarBlackBoxRecipeFixture } from '@shared-test/rallar-bb-test/recipe-fixtures.ts';

export function createExecutePreviewExport(fixture: RallarBlackBoxRecipeFixture) {
    return {
        schemaVersion: 1,
        kind: 'rallar-recipe-console-preview',
        preview: true,
        live: false,
        fixtureId: fixture.fixtureId,
        recipeId: fixture.recipe.recipeId,
        recipe: fixture.recipe,
    } as const;
}

export function downloadExecutePreview(fixture: RallarBlackBoxRecipeFixture): void {
    const payload = `${JSON.stringify(createExecutePreviewExport(fixture), null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rallar-recipe-preview-${fixture.fixtureId}-${fixture.recipe.recipeId}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    queueMicrotask(() => URL.revokeObjectURL(url));
}
