import './style.css';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Application root is missing.');
}
const lifetime = new AbortController();
let current: { stop(): void | Promise<void>; } | undefined;
let teardown: Promise<void> = import.meta.hot?.data.teardown ?? Promise.resolve();
let generation = 0;
void openMode(root, 'solo');

async function openMode(element: HTMLElement, mode: 'solo' | 'online'): Promise<void> {
    const revision = ++generation;
    const previous = current;
    current = undefined;
    try {
        teardown = Promise.all([teardown, previous?.stop()]).then(() => {}).catch((error) => {
            console.warn('Online cleanup incomplete:', error instanceof Error ? error.message : 'Reconnect to retry.');
        });
        element.innerHTML = '<main class="loading"><h1>Opening Grumpy Town…</h1></main>';
        if (mode === 'solo') {
            const { PracticeApp } = await import('./practice-app.ts');
            if (!lifetime.signal.aborted && revision === generation) {
                current = new PracticeApp(element, () => void openMode(element, 'online'));
            }
        }
        else {
            await teardown;
            const { OnlineLobby } = await import('./online/online-lobby.ts');
            if (!lifetime.signal.aborted && revision === generation) {
                current = new OnlineLobby(element, () => void openMode(element, 'solo'));
            }
        }
    }
    catch (error) {
        if (lifetime.signal.aborted || revision !== generation) {
            return;
        }
        element.innerHTML =
            '<main class="loading"><h1>Could not open the town.</h1><p id="error" role="alert"></p><a href="">Try again</a></main>';
        const message = element.querySelector('#error');
        if (message) {
            message.textContent = error instanceof Error ? error.message : 'Please use a browser with WebGL enabled.';
        }
    }
}

function stopApplication(): void {
    lifetime.abort();
    generation += 1;
    teardown = Promise.all([teardown, current?.stop()]).then(() => {}).catch(() => {});
    current = undefined;
    if (import.meta.hot) {
        import.meta.hot.data.teardown = teardown;
    }
}
if (import.meta.hot) {
    import.meta.hot.dispose(stopApplication);
}
window.addEventListener('pagehide', stopApplication);
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        location.reload();
    }
});
