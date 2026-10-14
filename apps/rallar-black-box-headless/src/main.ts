import { createDefaultRallarBlackBoxBrowserControlAgent } from '@shared-test/rallar-bb-test/browser-control-agent.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { HeadlessStatusView } from './status-view.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
    throw new Error('Missing #root for rallar black-box headless agent.');
}

const agent = createDefaultRallarBlackBoxBrowserControlAgent({
    search: window.location.search,
    env: (import.meta as { env?: Record<string, string | undefined>; }).env ?? {},
    hash: window.location.hash
});

const statusView = new HeadlessStatusView(root, () => agent.getSnapshot());

agent.subscribe(() => statusView.requestRender());
statusView.render();

function recordStartFailure(failure: string): void {
    agent.recordStatus(failure);
    statusView.render();
}

// start() returns expected failures as values; an unexpected rejection must still reach the status line.
void agent.start().then(
    (started) => started.foldLeft(recordStartFailure),
    (error) => recordStartFailure(toError(error).message)
);

window.addEventListener('pagehide', () => {
    agent.dispose();
}, { once: true });
