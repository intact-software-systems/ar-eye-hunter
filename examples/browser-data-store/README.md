# Browser Data Store

Rallar Data is browser-local latest-value storage. Use it for local preferences,
drafts, debug artifacts, and cross-tab coordination. Do not use it as live match
authority or as a CRDT.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

type Settings = {
    volume: number;
    graphics: 'low' | 'medium' | 'high';
    showNetworkDebug: boolean;
};

const settings = await rallar.data.open<Settings>('settings', {
    scope: 'principal',
    durability: 'write-through',
    hydrate: 'eager',
    sync: true,
    schemaVersion: 1,
    isValid: (value) =>
        typeof value.volume === 'number' &&
        ['low', 'medium', 'high'].includes(value.graphics)
});

settings.onChange((event) => {
    renderSettings(event.value);
});

await settings.set('ui', {
    volume: 0.75,
    graphics: 'medium',
    showNetworkDebug: false
});

await settings.updateOrCreate('ui', (current) => ({
    volume: current?.volume ?? 0.75,
    graphics: 'high',
    showNetworkDebug: current?.showNetworkDebug ?? false
}));

await settings.whenIdle();
```

Use `durability: 'write-behind'` for high-frequency local drafts, and call
`whenIdle()` or `flush()` before important navigation boundaries.
