import type { RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';

export function isRuntimeStateReadBatchKeySelected(
    selector: RuntimeStateReadBatchSelector,
    key: string
): boolean {
    switch (selector.kind) {
        case 'key':
            return key === selector.key;
        case 'prefix':
            return key.startsWith(selector.keyPrefix);
        case 'prefix-suffix':
            // The prefix and the suffix must not share characters, matching the SQL length bound.
            return key.length >= selector.keyPrefix.length + selector.keySuffix.length &&
                key.startsWith(selector.keyPrefix) &&
                key.endsWith(selector.keySuffix);
    }
}
