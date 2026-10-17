import type { RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';

/** The key, prefix or suffix a selector names, for reporting the selection a read conflict changed. */
export function toRuntimeStateReadBatchSelectedKey(selector: RuntimeStateReadBatchSelector): string {
    switch (selector.kind) {
        case 'key':
            return selector.key;
        case 'prefix':
        case 'prefix-suffix':
            return selector.keyPrefix;
        case 'suffix':
            return selector.keySuffix;
    }
}
