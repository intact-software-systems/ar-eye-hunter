import { ROOM_GUEST_LIFETIME_MS } from '@shared/api/room-guests/invitation.ts';

// Only the admission process runs with this clock. PostgreSQL and all subsequent processes use real time.
const systemNow = Date.now;
Date.now = () => systemNow() - ROOM_GUEST_LIFETIME_MS + 40_000;
