import type { RallarBlackBoxTestCommandKind } from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from '../schema/rallar-black-box-command-capabilities.ts';

export type CommandCapability = typeof RALLAR_BLACK_BOX_COMMAND_CAPABILITIES[number];

const CAPABILITY_BY_KIND = new Map(
    RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map((capability) => [capability.kind, capability])
);

export function resolveCommandCapability(
    kind: RallarBlackBoxTestCommandKind
): CommandCapability | undefined {
    return CAPABILITY_BY_KIND.get(kind);
}

export function resolveCommandCapabilities(
    kinds: readonly RallarBlackBoxTestCommandKind[]
): readonly CommandCapability[] {
    return kinds
        .map(resolveCommandCapability)
        .filter((capability): capability is CommandCapability => Boolean(capability));
}
