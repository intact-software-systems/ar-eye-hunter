import { rallar } from '@shared-web/browser/rallar.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';

export const ARENA_ROOM_SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export const arenaRoomEntry = RallarRoomEntry.createBrowser(rallar, { scope: ARENA_ROOM_SCOPE });
export const arenaRecentRooms = RallarRecentRooms.createBrowser(rallar, arenaRoomEntry, { scope: ARENA_ROOM_SCOPE });
