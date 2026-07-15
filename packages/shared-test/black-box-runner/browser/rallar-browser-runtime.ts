export type * from './rallar-browser-runtime/runtime.ts';

import { installBlackBoxRallarRuntime } from './rallar-browser-runtime/runtime.ts';

installBlackBoxRallarRuntime(window);
