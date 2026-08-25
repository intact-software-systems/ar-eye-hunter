import type { RallarDataScope } from '@shared-web/browser/rallar-data.ts';

export type Todo = Readonly<{
    title: string;
    done: boolean;
}>;

export const resolveTestDataScopeKey = (scope: RallarDataScope): string => String(scope);

export class FakeBroadcastChannel {
    private static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

    public onmessage: ((event: MessageEvent<object>) => void) | null = null;

    public readonly name: string;

    public constructor(name: string) {
        this.name = name;
        const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
        channels.add(this);
        FakeBroadcastChannel.channels.set(name, channels);
    }

    public postMessage(message: object): void {
        for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
            if (channel === this) {
                continue;
            }

            queueMicrotask(() => {
                channel.onmessage?.({ data: message } as MessageEvent<object>);
            });
        }
    }

    public close(): void {
        FakeBroadcastChannel.channels.get(this.name)?.delete(this);
    }

    public static clear(): void {
        FakeBroadcastChannel.channels.clear();
    }
}

export async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (predicate()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!predicate()) {
        throw new Error('Expected the condition to become true before the test timeout.');
    }
}
