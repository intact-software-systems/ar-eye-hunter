import type { RallarCrdtClockSummary } from './crdt-types.ts';

export type RallarCrdtLamportClock = Readonly<{
    replicaId: string;
    read(): number;
    tick(observedLamport?: number): number;
    observe(lamport: number): number;
    snapshot(): RallarCrdtClockSummary;
}>;

export function createRallarCrdtLamportClock(
    replicaId: string,
    initialLamport = 0,
): RallarCrdtLamportClock {
    if (!replicaId.trim()) {
        throw new Error('CRDT replicaId is required.');
    }
    if (!Number.isInteger(initialLamport) || initialLamport < 0) {
        throw new Error(
            'CRDT initial Lamport value must be a non-negative integer.',
        );
    }

    let current = initialLamport;
    const replicaClocks: Record<string, number> = {
        [replicaId]: initialLamport,
    };

    const remember = (id: string, lamport: number): void => {
        replicaClocks[id] = Math.max(replicaClocks[id] ?? 0, lamport);
    };

    return {
        replicaId,
        read: () => current,
        tick: (observedLamport = current): number => {
            current = Math.max(current, observedLamport) + 1;
            remember(replicaId, current);
            return current;
        },
        observe: (lamport: number): number => {
            if (!Number.isInteger(lamport) || lamport < 0) {
                throw new Error(
                    'Observed Lamport value must be a non-negative integer.',
                );
            }

            current = Math.max(current, lamport);
            return current;
        },
        snapshot: (): RallarCrdtClockSummary => ({
            maxLamport: current,
            replicaClocks: Object.fromEntries(
                Object.entries(replicaClocks).sort(([left], [right]) =>
                    left.localeCompare(right),
                ),
            ),
        }),
    };
}

export function mergeRallarCrdtClockSummary(
    left: RallarCrdtClockSummary | undefined,
    right: RallarCrdtClockSummary | undefined,
): RallarCrdtClockSummary {
    const replicaClocks: Record<string, number> = {};

    for (const summary of [left, right]) {
        if (!summary) {
            continue;
        }

        for (const [replicaId, lamport] of Object.entries(
            summary.replicaClocks,
        )) {
            replicaClocks[replicaId] = Math.max(
                replicaClocks[replicaId] ?? 0,
                lamport,
            );
        }
    }

    return {
        maxLamport: Math.max(left?.maxLamport ?? 0, right?.maxLamport ?? 0),
        replicaClocks: Object.fromEntries(
            Object.entries(replicaClocks).sort(([leftId], [rightId]) =>
                leftId.localeCompare(rightId),
            ),
        ),
    };
}
