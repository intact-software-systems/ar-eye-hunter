import { createDefaultRallarBlackBoxBrowserControlAgent } from '@shared-test/rallar-bb-test/browser-control-agent.ts';
import { renderHeadlessStatus } from './status-view.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
    throw new Error('Missing #root for rallar black-box headless agent.');
}
const rootElement = root;

const agent = createDefaultRallarBlackBoxBrowserControlAgent({
    search: window.location.search,
    env: (import.meta as { env?: Record<string, string | undefined>; }).env ?? {},
    hash: window.location.hash
});

function render(): void {
    renderHeadlessStatus(rootElement, agent.getSnapshot());
}

agent.subscribe(render);
render();

void agent.start().then((started) => {
    started.foldLeft((failure) => {
        agent.recordStatus(failure);
        render();
    });
});

window.addEventListener('pagehide', () => {
    agent.dispose();
}, { once: true });
