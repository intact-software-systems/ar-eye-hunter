import { createRoot } from 'react-dom/client';

async function renderFixture(): Promise<void> {
    const root = document.querySelector('#root');
    if (!root) throw new Error('CSS isolation fixture root is missing.');

    await import('../../src/recipe-console/design/tokens.css');
    await import('../../src/recipe-console/design/reset.css');
    await import('../../src/styles.css');
    await import('../../src/legacy/accessibility/legacy-accessibility.css');
    const { RecipeConsoleIsolationSamples } = await import('./RecipeConsoleIsolationSamples.tsx');
    const { LegacyIsolationSamples } = await import('./LegacyIsolationSamples.tsx');

    createRoot(root).render(
        <>
            <LegacyIsolationSamples />
            <RecipeConsoleIsolationSamples />
        </>,
    );
}

void renderFixture();
