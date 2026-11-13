import { Temporal } from '@js-temporal/polyfill';

// TypeScript declares a native `globalThis.Temporal` whose shape differs from the polyfill's, so
// the polyfill has to be installed through a property definition rather than a typed assignment.
if (!('Temporal' in globalThis)) {
    Object.defineProperty(globalThis, 'Temporal', {
        configurable: true,
        // The polyfill namespace is frozen; Vitest's fake clock needs a configurable `Now`.
        value: { ...Temporal },
        writable: true
    });
}
