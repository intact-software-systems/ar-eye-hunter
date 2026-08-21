import { useEffect, useRef } from 'react';

export type LatestRequestTicket = Readonly<{
    isCurrent: () => boolean;
}>;

export type LatestRequestGuard = Readonly<{
    begin: () => LatestRequestTicket;
    invalidate: () => void;
}>;

export function useLatestRequestGuard(): LatestRequestGuard {
    const generation = useRef(0);
    const guard = useRef<LatestRequestGuard | undefined>(undefined);

    if (!guard.current) {
        guard.current = {
            begin: () => {
                const requestGeneration = generation.current + 1;
                generation.current = requestGeneration;
                return {
                    isCurrent: () => generation.current === requestGeneration
                };
            },
            invalidate: () => {
                generation.current += 1;
            }
        };
    }

    useEffect(() => () => guard.current?.invalidate(), []);

    return guard.current;
}
