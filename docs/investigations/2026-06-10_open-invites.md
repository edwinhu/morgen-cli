# Investigation: Morgen "Open Invites" (one-off booking links)

**Date:** 2026-06-10
**Goal:** Reverse-engineer how Morgen creates an "Open Invite" (a one-off, time-boxed booking
link offering specific proposed slots for a 1:1) so the CLI can mint one and drop it into an
email reply — mirroring `superhuman-cli`'s `availability` pattern.

**Method:** Extracted and grepped the Morgen Electron bundle
(`/Applications/Morgen.app/Contents/Resources/app.asar` → `dist/app.js`, 14 MB), then did a
**live capture** against the running app via CDP (port 9253): pulled the Firebase auth state
from IndexedDB, read the real scheduling-link docs straight out of Firestore, and created +
resolved + deleted a real test link end-to-end.

---

## TL;DR — feasible, fully validated, no app required at runtime

An Open Invite is **not** a REST resource on `api.morgen.so`. It is a document in the user's
**Firestore** subcollection `users/{uid}/schedulingLinks/{providerId}` in the Firebase project
**`morgen-d34db`**. The Morgen app writes it directly via the Firebase SDK (its "internal sync"
engine); there is no backend mint endpoint. The shareable link is minted **client-side** — the
`href` is just a random id the client generates, exactly like Superhuman's `externalId`.

To create one from the CLI:

1. Get a **Firebase ID token** for `morgen-d34db` (mint it app-independently from the stored
   Firebase refresh token via `securetoken.googleapis.com`).
2. Generate a `uuid` → `providerId = "<uuid>@morgen.so"`, plus `href` (15 url-safe chars + `-`)
   and `hrefShort` (6 lowercase alnum) **locally**.
3. Write the complete doc to Firestore via the REST `:commit` endpoint.
4. The link is `https://book.morgen.so/<href>`.

Verified end-to-end: a doc written this way is resolved by the public booking API
(`GET https://api.morgen.so/scheduler/fetchBookingInfo?href=<href>`), which expands the proposed
window into bookable slots and returns the owner/title. A complete, well-formed doc **survives**
the running app's sync (the app even shows it in its UI). The test link was deleted afterward;
nobody was notified (creating a link notifies no one — only a booking would).

**Conclusion:** justified to implement as `morgen open-invite`. This makes superhuman-cli's link
no longer the only option for one-off booking links from an agent.

---

## The data model (ground truth from live Firestore docs)

Firebase config (from the bundle):

```
projectId   = morgen-d34db
apiKey      = AIzaSyAwUKDVKN5gm_EsRKGeKBO0sdnGAqlkbhQ
authDomain  = morgen-d34db.firebaseapp.com
```

Scheduling links live at Firestore path `users/{uid}/schedulingLinks/{docId}` where
`docId = encodeURIComponent(providerId)` and `providerId = "<uuid>@morgen.so"` (so the `@`
becomes `%40` in the doc id). The synced field set (from
`startSyncCollection("schedulingLinks", [...])` in the bundle) is:

```
href, hrefShort, type, visibility, bookingOptions, event, attendee,
cohosts, cohostsAssignment, additionalAttendees, bookedEvents, error, isPreview
```

…plus the sync engine adds `_id` (the bare uuid), `_acl: []`, `providerId`, `mtStamp` (client
ISO string), `mtInternalSync: "synced"`, `__v: 3`, and `__stamp` (server timestamp).

A **one-time** Open Invite vs. a recurring **booking page**:

| Field | Open Invite (one-time) | Booking page (recurring) |
|-------|------------------------|--------------------------|
| `type` | `"one-time-link"` | `"permanent-link"` |
| `visibility` | `"private"` | `"public"` |
| `bookingOptions.recurrent` | `false` | `true` |
| `bookingOptions.predefinedSlots` | the proposed windows | (optional) |
| link form | `book.morgen.so/<href>` | `book.morgen.so/<username>/<hrefShort>` |

`bookingOptions` shape (one-time), values mirrored from `createSchedulingLink` defaults in the
bundle and a real doc:

```jsonc
{
  "durations": [30],                 // minutes; invitee picks one
  "minNotice": 60, "futureLimit": 40320, "buffer": 0,
  "stride": 0, "startGranularity": 15,
  "targetCalendar": "<calendar.id>",        // == v3 calendar id (base64 [accountId, providerCalId])
  "targetAccount":  "<calendar.accountId>",
  "organizerAccountEmail": "<calendar.ownedBy.email>",
  "disableAvailabilityCheck": false,        // false = also gray out live conflicts
  "recurrent": false,
  "predefinedSlotsTimezone": "America/New_York",
  "predefinedSlots": ["2026-06-12T14:00:00Z/2026-06-12T17:00:00Z"],  // "startISO/endISO" windows, UTC
  "customQuestions": [],
  "reminders": { "useDefault": false,
                 "overrides": [{ "method": "email", "recipients": "organizerAndInvitee", "minutes": 10 }] }
}
```

`event` = `{ summary, description?, location? }`. The proposed `predefinedSlots` are **windows**
(`start/end`), not individual slots — the server chops each window into `duration`-sized bookable
slots (a 14:00–17:00Z window with `durations:[30]` → six 30-min slots).

The v3 calendar object (`/v3/calendars/list`) gives all three target fields directly:
`targetCalendar = calendar.id`, `targetAccount = calendar.accountId`,
`organizerAccountEmail = calendar.ownedBy.email`.

### The link id is minted client-side

From the bundle:

```js
generateBookingHref()      { return `${tO()}-` }          // 15 url-safe chars + "-"
generateBookingHrefShort() { /* 6-char unique slug */ }
// set in the editor before save, only when the link has no providerId yet:
e.href = generateBookingHref(); e.hrefShort = generateBookingHrefShort();
```

Real hrefs observed: `b4ijViI3X7p8Fkl-`, `eH05EtCI9B84NXr-` (15 base62 + trailing `-`). The
booking backend stores whatever we write, so any unique url-safe value resolves; we replicate the
format for fidelity.

## Auth: Firebase token, app-independent

The app stores Firebase auth in IndexedDB `firebaseLocalStorageDb` →
`firebase:authUser:<apiKey>:[DEFAULT]` with `{ uid, stsTokenManager: { accessToken, refreshToken } }`.
`accessToken` is a Firebase ID JWT (`aud: morgen-d34db`, 1 h TTL). It can be refreshed **without
the app** via the Secure Token API:

```
POST https://securetoken.googleapis.com/v1/token?key=<apiKey>
  grant_type=refresh_token & refresh_token=<refreshToken>
→ { id_token, refresh_token, user_id, expires_in }
```

So the CLI grabs `{uid, refreshToken, apiKey}` from the app's IndexedDB once (via CDP, same as
existing `morgen auth`), caches it, and mints fresh Firebase ID tokens on its own thereafter.
This is a **separate** token from the `api.morgen.so` apiToken the rest of the CLI uses —
Firestore needs the Firebase ID token specifically.

## Write + read endpoints (Firestore REST)

```
# create / update (server timestamp on __stamp via transform)
POST https://firestore.googleapis.com/v1/projects/morgen-d34db/databases/(default)/documents:commit
  Authorization: Bearer <firebase id token>
  { "writes": [ { "update": { "name": ".../schedulingLinks/<docId>", "fields": {…} },
                  "updateTransforms": [ { "fieldPath": "__stamp", "setToServerValue": "REQUEST_TIME" } ] } ] }

# read one / list
GET  .../users/{uid}/schedulingLinks/<docId>
GET  .../users/{uid}/schedulingLinks?pageSize=100
```

## Resolving / verifying a link (public, no auth)

```
GET https://api.morgen.so/scheduler/fetchBookingInfo?href=<href>
→ 200 { href, owner:{email,firstName,lastName,company,branding}, slots:[ "ISO/ISO", … ],
        event:{summary}, durations:[…] }
→ 404 if no such href
```

Other scheduler endpoints seen in the booking-site bundle: `fetchLandingPageInfo` (by username,
for recurring pages), `bookMeetingSlot`, `cancelBookedEvent`, `rescheduleBookedEvent`.

## Delete semantics (important for cleanup)

Morgen uses **soft delete**: it sets `mtInternalSync: "deleted"` and strips the content fields
(`href`, `type`, `event`, …) rather than removing the Firestore doc. A naive hard `DELETE` is
**re-pushed** by a running app (it still has the doc in its local RxDB and re-syncs it), and the
scheduler resolves a link purely by `href` regardless of `mtInternalSync` — so to actually kill a
link you must overwrite the doc to the minimal deleted shape (drop `href`):

```
{ providerId, mtInternalSync: "deleted", __v: 3, __stamp: <server ts> }   // no href → fetchBookingInfo 404s
```

## Gotchas discovered

- **`_id` is required.** A doc missing `_id`/`_acl`/`mtStamp`/`customQuestions` was found by the
  scheduler (500, not 404) but failed to render, and a running app stripped it on reconciliation.
  The full field set fixes both.
- **`UID` is a readonly zsh integer** — don't use it as a shell var name when scripting Firestore
  paths (it triggers a math-eval error).
- **Single-doc GET** needs the `%40` kept literal in the path; the collection-list endpoint is
  unaffected.
- The Morgen Electron app holds a single-instance lock, so `--remote-debugging-port` is ignored if
  an instance is already running; fully quit it first to enable CDP.

## Video conferencing (virtualRoom) — added 2026-06-10

A booked meeting gets a conferencing link via `bookingOptions.virtualRoom`. Three services
(from the bundle): `morgen` (a static **personal meeting room**, e.g. a personal Zoom URL),
`googleMeet` (auto-created per booking), `teams`. The app's editor sets:

```js
bookingOptions.virtualRoom = { accountId, serviceName, meetingId: null, meetingUrl: null }
//   personal room → accountId = room.providerId (serviceName "morgen")
//   Google Meet   → accountId = `google::${calendarAccountId}` (serviceName "googleMeet")
//   Teams         → accountId = `o365::${calendarAccountId}`   (serviceName "teams")
```

Personal meeting rooms live in their own Firestore collection `users/{uid}/rooms`, each
`{ url, displayName, providerId }`. For a personal room the persisted virtualRoom fills in the
URL/id directly (matching a real booking page):

```jsonc
"virtualRoom": {
  "serviceName": "morgen",
  "accountId":   "<room.providerId>",     // "<uuid>@morgen.so"
  "meetingId":   "<room.providerId>",
  "meetingUrl":  "<room.url>"             // e.g. https://law-virginia.zoom.us/j/3823453577
}
```

The CLI defaults to **auto**: attach the personal meeting room if the account has one (matching how
the user's existing booking pages behave), else none. Verified end-to-end — an auto-conferencing
invite persists the exact virtualRoom shape of a working booking page.

NOTE: `fetchBookingInfo` does **not** surface conferencing pre-booking; the link is applied to the
created event at booking time (the captured `bookedEvents` of a real page show the Zoom URL in the
event description + virtualRoom). Original `open-invite` (shipped earlier in v0.9.0) omitted
virtualRoom, so meetings booked through it had no video link — fixed in v0.9.1.

### CRITICAL: a static room's `virtualRoom` is NOT injected into the booked calendar event (v0.9.2)

Confirmed by a real booking (Olivia Sahid, 2026-06-15): an invite with `virtualRoom`
(serviceName `morgen`, meetingUrl = the Zoom) produced a booked Outlook event that had the
virtualRoom on Morgen's internal `bookedEvents` record **but no Zoom anywhere in the actual
calendar event** (no `location`, nothing in the description). Only **Google Meet / Teams** are
auto-created per booking and appear natively; a **static personal room** ("morgen") is not pushed
into the o365 event body.

The reason the user's existing office-hours booking page shows the Zoom: its link **`event.description`
(organizer notes)** literally contains `Join Meeting\nhttps://…zoom…`, and the booking flow copies
organizer notes into every booked event as `Organizer notes: …`. So the operative mechanism for a
static room is the description, not virtualRoom.

Fix (v0.9.2): for a static personal room, also prepend `Join meeting:\n<url>` to the link's
`event.description`. Keep `virtualRoom` too (Morgen-native UI + it's harmless). Google Meet/Teams
do NOT get a description URL (auto-created natively). Also note: the Morgen **`/v3/events/update`
whitelist rejects a `location` field** — to retro-fit the Zoom onto an already-booked event you must
edit the event **description** (200), not location (400 `property location should not exist`).

## CLI shape implemented

```
morgen open-invite --slots "<startISO>/<endISO>,…" [--title T] [--duration 30]
                   [--calendar <name>] [--timezone <tz>] [--location L] [--description D]
                   [--no-availability-check]
                   [--conferencing auto|room|zoom|google-meet|teams|none] [--room <name>] [--no-conferencing]
morgen open-invite list
morgen open-invite rooms
morgen open-invite delete <href|id>
```

Mints the link client-side, writes the Firestore doc, verifies via `fetchBookingInfo`, and prints
`https://book.morgen.so/<href>`.
