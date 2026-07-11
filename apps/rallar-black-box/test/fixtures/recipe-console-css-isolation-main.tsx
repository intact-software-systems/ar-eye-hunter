import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import '../../src/recipe-console/design/tokens.css';
import '../../src/recipe-console/design/reset.css';
import { LegacyIsolationSamples } from './LegacyIsolationSamples.tsx';
import { RecipeConsoleIsolationSamples } from './RecipeConsoleIsolationSamples.tsx';

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'both';
const root = document.querySelector('#root');
if (!root) throw new Error('CSS isolation fixture root is missing.');

createRoot(root).render(
    <>
        {mode === 'legacy' || mode === 'both' ? <LegacyIsolationSamples /> : null}
        {mode === 'recipe-console' || mode === 'both' ? <RecipeConsoleIsolationSamples /> : null}
    </>,
);
