import type { RallarBlackBoxTestFaultInjectCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** A fault in a recipe's command outline: its carrier, and how many matches it consumes or a product socket's action. */
export function toFaultInjectShape(command: RallarBlackBoxTestFaultInjectCommand): string {
    const extent = command.carrier === 'product-socket' ? command.action : command.remaining;
    return `fault.inject:${command.carrier}:${String(extent)}`;
}
