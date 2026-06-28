import {
    createRallarBlackBoxBrowserControlAgent,
} from '@shared-test/rallar-bb-test/browser-control-agent.ts';
import { renderHeadlessStatus } from './status-view.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
    throw new Error('Missing #root for rallar black-box headless agent.');
}
const rootElement = root;

const agent = createRallarBlackBoxBrowserControlAgent({
    search: window.location.search,
    env: (import.meta as { env?: Record<string, string | undefined> }).env ?? {},
});

function render(): void {
    renderHeadlessStatus(rootElement, agent.getSnapshot());
}

agent.subscribe(render);
render();

void agent.start().catch((error) => {
    agent.recordStatus(
        error instanceof Error ? error.message : String(error),
    );
    render();
});

window.addEventListener('pagehide', () => {
    agent.dispose();
}, { once: true });
