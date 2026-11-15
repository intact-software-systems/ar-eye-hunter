import './style.css';
import type { PracticeApp } from './practice-app.ts';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Application root is missing.');
}
const lifetime = new AbortController();
let practice: PracticeApp | undefined;
root.innerHTML =
    '<main class="loading"><p class="eyebrow">CCA / CUTOUT PLAYGROUND</p><h1>Opening the market…</h1><p>Movement · dash + drop · ice · zoom</p></main>';
void openPractice(root);

async function openPractice(element: HTMLElement): Promise<void> {
    try {
        const { PracticeApp } = await import('./practice-app.ts');
        if (lifetime.signal.aborted) {
            return;
        }
        practice = new PracticeApp(element);
    }
    catch (error) {
        if (lifetime.signal.aborted) {
            return;
        }
        element.innerHTML =
            '<main class="loading"><h1>Could not open the market.</h1><p id="error" role="alert"></p><a href="">Try again</a></main>';
        const message = element.querySelector('#error');
        if (message) {
            message.textContent = error instanceof Error ? error.message : 'Please use a browser with WebGL enabled.';
        }
    }
}

function stopPractice(): void {
    lifetime.abort();
    practice?.stop();
}
if (import.meta.hot) {
    import.meta.hot.dispose(stopPractice);
}
window.addEventListener('pagehide', stopPractice);
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        location.reload();
    }
});
