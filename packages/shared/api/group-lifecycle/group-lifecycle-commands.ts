import type { GroupLifecycleTransition } from './group-lifecycle-transitions.ts';

/**
 * The eight commands an application issues against a group's lifecycle, each
 * the last path segment of `…/groups/{groupId}/lifecycle/{command}/requests/{requestId}`:
 * the six transitions an initiator may command (`fail-formation` belongs to the
 * activation criterion) and the two transport commands, which change no stage.
 * The wire spelling has one owner here; the browser command union derives from it.
 */
export const GROUP_LIFECYCLE_COMMANDS = [
    'plan',
    'connect',
    'activate',
    'reconfigure',
    'pause',
    'resume',
    'reset',
    'start'
] as const satisfies readonly (Exclude<GroupLifecycleTransition, 'fail-formation'> | 'pause' | 'resume')[];

export type GroupLifecycleCommand = typeof GROUP_LIFECYCLE_COMMANDS[number];
