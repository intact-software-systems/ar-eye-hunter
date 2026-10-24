import { RallarRecentRooms, RallarRoomEntry } from '@shared-web/browser/rallar-room-entry.ts';
import { rallar } from '@shared-web/browser/rallar.ts';

export const ARENA_ROOM_SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export const arenaRoomEntry = RallarRoomEntry.createBrowser(rallar, { scope: ARENA_ROOM_SCOPE });
export const arenaRecentRooms = RallarRecentRooms.createBrowser(rallar, arenaRoomEntry, { scope: ARENA_ROOM_SCOPE });
