# Morgen-CLI Feature Requests

## Issue 1: Calendar CRUD operations

**Title:** Add calendar CRUD operations to morgen-cli

Currently, morgen-cli only supports task and calendar listing via AI chat. Missing calendar functionality:

**Needed features:**
- `morgen calendar list` - List all connected calendars with IDs and names
- `morgen calendar create` - Create a new event on a specific calendar
- `morgen calendar update <event-id>` - Update an existing calendar event
- `morgen calendar delete <event-id>` - Delete a calendar event
- `morgen calendar free` - Check free/busy time for availability planning

**Context:**
These calendar operations would complement the existing task management and enable workflows like:
- Blocking off time for deep work on tasks
- Checking availability across multiple calendars
- Creating calendar events programmatically from the CLI

**Reference:**
Superhuman CLI has these operations: `superhuman calendar list|create|update|delete|free`

---

## Issue 2: Calendar filtering/hiding

**Title:** Add calendar filtering/hiding to AI chat and availability commands

When checking calendar availability or getting AI suggestions for free time, the CLI includes all connected calendars (personal, family, shared, holidays). This creates false positives when shared calendars contain other people's events that shouldn't block your availability.

**Problem:**
User has 9 calendars including shared ones (Family, partner's calendar, etc.). When asking "find me a 3-hour block this week", the AI returns times that conflict with shared events, not the user's actual availability.

**Desired behavior:**
- Add option to specify which calendars to include: `morgen chat "find 3 hours" --calendars gmail,family`
- Or add option to exclude calendars: `morgen chat "find 3 hours" --exclude-calendars natalie,work`
- Add `--only-primary` flag to only use the primary calendar

**Workaround (not ideal):**
User has to manually hide shared calendars in Google Calendar before running CLI commands.

**Impact:**
This blocks task planning workflows that rely on accurate availability detection.

---

**Date filed:** 2026-02-08
**Filed by:** Eddy Hu
