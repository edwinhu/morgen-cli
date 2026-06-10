/**
 * Morgen CLI - Library exports
 */

export { morgenFetch, MorgenApiError } from "./morgen-api.ts";
export {
  listTasks,
  listAllTasks,
  listIntegrationAccounts,
  decodeIntegrationId,
  getTask,
  createTask,
  updateTask,
  closeTask,
  reopenTask,
  deleteTask,
  moveTask,
} from "./tasks.ts";
export {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findFreeSlots,
  resetCalendarCache,
} from "./calendars.ts";
export { sendChat, parseSSEStream } from "./chat.ts";
export { convertToTimezone, formatTimeForDisplay } from "./time.ts";
export { TOOL_DEFINITIONS, executeTool } from "./tools.ts";
export type { ListTasksOptions } from "./tasks.ts";
export {
  authenticate,
  getSessionToken,
  loadSession,
  saveSession,
  isMorgenRunning,
} from "./morgen-cdp.ts";
export type { SessionInfo, ConnectionSource } from "./morgen-cdp.ts";
export {
  getFirebaseSession,
  authenticateFirebase,
  FIREBASE_PROJECT_ID,
} from "./morgen-firebase.ts";
export type { FirebaseSession, FirebaseCredentials } from "./morgen-firebase.ts";
export {
  createOpenInvite,
  listOpenInvites,
  listRooms,
  deleteOpenInvite,
  fetchBookingInfo,
  parseSlots,
} from "./open-invite.ts";
export type {
  OpenInvite,
  OpenInviteSlot,
  CreateOpenInviteInput,
  Conferencing,
  MeetingRoom,
} from "./open-invite.ts";
export type * from "./types.ts";
