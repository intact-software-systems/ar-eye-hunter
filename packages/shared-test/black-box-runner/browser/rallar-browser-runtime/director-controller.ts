import type { BlackBoxRallarGenerationPort } from './ports.ts';

export type BlackBoxRallarDirectorLease = Readonly<{
    generation: number;
}>;

export type BlackBoxRallarDirectorController<TRelay> = Readonly<{
    lease(): BlackBoxRallarDirectorLease;
    assertCurrent(lease: BlackBoxRallarDirectorLease, message: string): void;
    add(handle: string, relay: TRelay): void;
    require(handle: string): TRelay;
    take(handle: string): TRelay;
    delete(handle: string): boolean;
    entries(): readonly (readonly [string, TRelay])[];
    handles(): readonly string[];
}>;

export function createBlackBoxRallarDirectorController<TRelay>(
    generationPort: BlackBoxRallarGenerationPort,
): BlackBoxRallarDirectorController<TRelay> {
    const relays = new Map<string, TRelay>();

    const add = (handle: string, relay: TRelay): void => {
        if (relays.has(handle)) {
            throw new Error('Director relay handle is already active: ' + handle);
        }
        relays.set(handle, relay);
    };

    const requireRelay = (handle: string): TRelay => {
        const relay = relays.get(handle);
        if (!relay) {
            throw new Error('Director relay handle is not active: ' + handle);
        }
        return relay;
    };

    const take = (handle: string): TRelay => {
        const relay = requireRelay(handle);
        relays.delete(handle);
        return relay;
    };

    return {
        lease: () => ({ generation: generationPort.generation() }),
        assertCurrent: (lease, message) => {
            if (!generationPort.isCurrent(lease.generation)) {
                throw new Error(message);
            }
        },
        add,
        require: requireRelay,
        take,
        delete: handle => relays.delete(handle),
        entries: () => [...relays.entries()],
        handles: () => [...relays.keys()],
    };
}
