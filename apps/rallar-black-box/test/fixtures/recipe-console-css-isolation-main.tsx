import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

async function renderFixture(): Promise<void> {
    const mode = new URLSearchParams(window.location.search).get('mode') ?? 'both';
    const root = document.querySelector('#root');
    if (!root) {
        throw new Error('CSS isolation fixture root is missing.');
    }

    let legacySample: ReactNode;
    let recipeSample: ReactNode;
    if (mode === 'legacy' || mode === 'both') {
        await import('../../src/styles.css');
        await import('../../src/legacy/accessibility/legacy-accessibility.css');
        const { LegacyIsolationSamples } = await import('./LegacyIsolationSamples.tsx');
        legacySample = <LegacyIsolationSamples />;
    }
    if (mode === 'recipe-console' || mode === 'both') {
        await import('../../src/recipe-console/design/tokens.css');
        await import('../../src/recipe-console/design/reset.css');
        const { RecipeConsoleIsolationSamples } = await import('./RecipeConsoleIsolationSamples.tsx');
        recipeSample = <RecipeConsoleIsolationSamples />;
    }

    createRoot(root).render(<>{legacySample}{recipeSample}</>);
}

void renderFixture();
