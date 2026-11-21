import type { PollAuthority } from './poll-authority.ts';
import { PollServiceUnavailable, requestPollSnapshot } from './request-poll-snapshot.ts';
import type { ShowPollInput } from './show-poll.ts';

/** Keep the selected room read-only until its authority supplies the first snapshot. */
export async function loadPollOnEntry(input: ShowPollInput, signal: AbortSignal): Promise<PollAuthority.Snapshot> {
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const retry = document.createElement('button');
    retry.textContent = 'Retry room snapshot';
    try {
        for (;;) {
            signal.throwIfAborted();
            status.textContent = 'Loading room poll';
            input.root.replaceChildren(status);
            try {
                return await requestPollSnapshot(input, signal);
            }
            catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof PollServiceUnavailable)) {
                    throw error;
                }
            }
            status.textContent = 'Room poll temporarily unavailable';
            input.root.append(retry);
            await new Promise<void>((resolve, reject) => {
                function cancel(): void {
                    reject(signal.reason);
                }
                retry.onclick = () => {
                    signal.removeEventListener('abort', cancel);
                    resolve();
                };
                signal.addEventListener('abort', cancel, { once: true });
            });
        }
    }
    finally {
        retry.onclick = null;
        retry.remove();
        status.remove();
    }
}
