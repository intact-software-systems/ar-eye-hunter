import './style.css';
import type { MarketApp } from './market-app.ts';

const root = document.getElementById('app');
if (!root) {
    throw new Error('Application root is missing.');
}
const lifetime = new AbortController();
let market: MarketApp | undefined;
let starting = false;
root.innerHTML =
    `<main class="landing"><p class="eyebrow">POCKET ARCADE MARKET</p><h1>Grab the gold.<br>Make your getaway.</h1><img class="mascot" src="/art/runner.webp" alt="Cat thief with a loot bag"><p>A tiny market. A tempting trail.<br>How much will you carry before you bank?</p><button id="practice" class="primary">Play solo practice</button><details><summary>Play with a friend</summary><form id="online"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><label>Room code <small>(empty to create)</small><input name="room" value="${
        escapeText(new URLSearchParams(location.search).get('room') ?? '')
    }" maxlength="200"></label><button class="primary">Enter market</button></form></details><p id="error" role="status"></p><small>Practice slice · move / dash / collect / bank</small></main>`;
root.querySelector('#practice')?.addEventListener('click', () => {
    void startLocal();
});
root.querySelector('#online')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void startOnline(event.target);
});

async function startLocal(): Promise<void> {
    if (!root || starting) {
        return;
    }
    starting = true;
    try {
        const { startPractice } = await import('./market-app.ts');
        lifetime.signal.throwIfAborted();
        market = startPractice(root);
    }
    catch (error) {
        showError(error);
        starting = false;
    }
}
async function startOnline(target: EventTarget | null): Promise<void> {
    if (!root || starting || !(target instanceof HTMLFormElement)) {
        return;
    }
    starting = true;
    const values = new FormData(target);
    const button = target.querySelector('button');
    if (button) {
        button.disabled = true;
    }
    showError(new Error('Connecting to the market…'));
    try {
        const [{ openOnlineMarket }, { MarketApp }] = await Promise.all([
            import('./online-market.ts'),
            import('./market-app.ts')
        ]);
        const session = await openOnlineMarket({
            username: String(values.get('username')),
            password: String(values.get('password')),
            roomId: String(values.get('room')).trim(),
            signal: lifetime.signal,
            apiBaseUrl: location.origin
        });
        market = new MarketApp(root, session);
        const url = new URL(location.href);
        url.searchParams.set('room', session.roomId);
        history.replaceState(null, '', url);
        const share = document.createElement('div');
        share.className = 'room-code';
        share.textContent = `Room: ${session.roomId}`;
        root.append(share);
    }
    catch (error) {
        starting = false;
        showError(error);
        if (button) {
            button.disabled = false;
        }
    }
}
function showError(error: unknown): void {
    const status = root?.querySelector('#error');
    if (status) {
        status.textContent = error instanceof Error
            ? [error.message, error.cause instanceof Error ? error.cause.message : ''].filter(Boolean).join(' ')
            : 'Could not start. Please retry.';
    }
}
function escapeText(value: string): string {
    return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        lifetime.abort();
        market?.stop();
    });
}
window.addEventListener('pagehide', () => {
    lifetime.abort();
    market?.stop();
});
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        location.reload();
    }
});
