import {
    useEffect,
    useState,
    useSyncExternalStore
} from 'react';
import { browserRelicRuntimeDeps } from './relic-hunters-browser.ts';
import { RelicHuntersRuntime } from './relic-hunters-runtime.ts';

/** React observes one runtime owner; cleanup fences every outstanding session and room operation. */
export function useRelicHunters(): RelicHuntersRuntime.Connection {
    const [runtime] = useState(() => new RelicHuntersRuntime(browserRelicRuntimeDeps()));
    const connection = useSyncExternalStore(runtime.subscribe, runtime.getState);
    useEffect(() => {
        void runtime.start();
        return () => runtime.stop();
    }, [runtime]);
    return connection;
}
