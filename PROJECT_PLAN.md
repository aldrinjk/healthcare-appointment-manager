# Healthcare Appointment & Follow-up Manager — Project Plan

## 1. Objective

Build a complete MVP healthcare appointment platform with separate workflows for:

* Patient
* Doctor
* Admin

The application must support:

* role-based authentication
* doctor management
* doctor working hours
* doctor leave
* doctor search by specialization
* safe appointment slot booking
* simultaneous booking protection
* temporary slot holds
* patient symptom submission
* AI pre-visit summaries
* doctor clinical notes
* prescriptions
* AI patient-friendly post-visit summaries
* medication reminders
* email notifications
* Google Calendar synchronization
* cancellation and rescheduling
* retryable background jobs
* graceful LLM/integration failures
* deployment
* documentation

The project should demonstrate strong engineering decisions rather than unnecessary feature breadth.

---

# 2. Target Architecture

```text
React + Vite + TypeScript
          |
          |
     Express REST API
          |
       Services
          |
    PostgreSQL + Prisma
          |
     OutboxJob Worker
      /      |       \
   Email    LLM    Calendar
```

PostgreSQL is the source of truth.

Appointment creation must not depend on:

* email availability
* Google Calendar availability
* LLM availability

External work should happen after durable database state has been created.

---

# 3. Target Repository Structure

```text
healthcare-appointment-manager/

├── client/
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── context/
│   │   ├── types/
│   │   └── utils/
│   └── package.json
│
├── server/
│   ├── src/
│   │   ├── controllers/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── middleware/
│   │   ├── integrations/
│   │   ├── jobs/
│   │   ├── utils/
│   │   ├── types/
│   │   └── app.ts
│   │
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   │
│   └── package.json
│
├── docs/
│   └── system-design.md
│
├── AGENTS.md
├── PROJECT_PLAN.md
├── IMPLEMENTATION_STATUS.md
├── README.md
├── .env.example
└── .gitignore
```

Do not create unnecessary folders simply to match this diagram if they are not useful.

---

# 4. Development Milestones

Work through milestones in the following order.

Do not skip ahead when a previous milestone contains broken core functionality.

---

# Milestone 1 — Foundation

## Goal

Create a clean runnable frontend/backend project.

## Backend

Create:

* Node.js
* Express
* TypeScript
* Prisma
* PostgreSQL configuration
* environment configuration
* standard error handling
* health endpoint

Suggested endpoint:

```text
GET /api/health
```

Expected:

```json
{
  "status": "ok"
}
```

## Frontend

Create:

* React
* Vite
* TypeScript
* routing
* API client structure
* basic layout

Do not focus on design yet.

## Repository

Create:

* `.gitignore`
* `.env.example`
* README skeleton
* IMPLEMENTATION_STATUS.md

## Done When

* frontend installs successfully
* backend installs successfully
* frontend builds
* backend TypeScript compiles
* server starts
* health endpoint responds
* no real secrets exist in source control

---

# Milestone 2 — Database Schema

## Goal

Create the main domain model.

At minimum implement:

### User

Fields should cover:

* id
* name
* email
* passwordHash
* role
* createdAt
* updatedAt

Roles:

```text
PATIENT
DOCTOR
ADMIN
```

### DoctorProfile

Support:

* linked User
* specialization
* slot duration
* profile information if useful

### DoctorAvailability

Support:

* doctor
* weekday
* start time
* end time

### DoctorLeave

Support:

* doctor
* leave date
* reason if useful

### Appointment

Support:

* patient
* doctor
* startAt
* endAt
* status
* symptoms
* preVisitSummary
* preSummaryStatus
* urgency
* clinicalNotes
* postVisitSummary
* postSummaryStatus
* calendar event identifier
* createdAt
* updatedAt

Suggested appointment statuses:

```text
BOOKED
COMPLETED
CANCELLED
```

### SlotReservation

Support:

* doctor
* patient
* startAt
* expiresAt
* status
* appointment relationship

Suggested reservation statuses:

```text
HOLD
BOOKED
```

Critical requirement:

The same doctor/start time must not be concurrently reserved more than once.

Use an appropriate database-level unique constraint.

### Prescription

Support:

* appointment
* medicine name
* dosage
* frequency
* duration
* instructions

The schema may support multiple medicines per appointment.

### MedicationReminder

Support:

* prescription
* scheduledAt
* status
* attempts if useful

### OutboxJob

Support:

* type
* payload
* status
* attempts
* nextAttemptAt
* lastError
* createdAt
* updatedAt

Suggested statuses:

```text
PENDING
PROCESSING
COMPLETED
FAILED
```

## Seed Data

Create useful development seed data.

Include at minimum:

* one admin
* multiple doctors with different specializations
* one or more patients
* doctor availability schedules

Use obvious development-only passwords documented in README.

## Done When

* Prisma schema validates
* migrations work
* seed script works
* database can be recreated from documented commands
* unique booking protection exists at database level

---

# Milestone 3 — Authentication and RBAC

## Goal

Implement secure role-based authentication.

## Endpoints

Suggested:

```text
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
```

Patient registration may be public.

Doctor/admin accounts can come from seed/admin management.

## Security

Use:

* bcrypt
* JWT
* authentication middleware
* role middleware

Implement helpers resembling:

```text
authenticate
requireRole
```

## Authorization Tests

Verify:

* unauthenticated user cannot access protected routes
* PATIENT cannot access ADMIN routes
* PATIENT cannot access DOCTOR-only actions
* DOCTOR cannot access ADMIN routes
* ADMIN can access admin routes

## Done When

Authentication works end-to-end and role restrictions are tested.

---

# Milestone 4 — Doctor Administration

## Goal

Allow admins to manage doctor scheduling data.

## Admin Capabilities

Admin should be able to:

* create doctor profile
* edit doctor profile
* set specialization
* configure working hours
* configure slot duration
* add leave dates
* remove leave dates where appropriate

Suggested routes:

```text
POST   /api/admin/doctors
PATCH  /api/admin/doctors/:id
POST   /api/admin/doctors/:id/availability
POST   /api/admin/doctors/:id/leave
DELETE /api/admin/doctors/:id/leave/:leaveId
```

Exact route structure may differ if cleaner.

## Done When

An admin can configure a doctor completely enough for patient slot generation.

---

# Milestone 5 — Doctor Search and Slot Generation

## Goal

Patients can discover doctors and see valid appointment slots.

## Patient Features

Patient can:

* list doctors
* filter by specialization
* open doctor details
* choose a date
* view available slots

Suggested endpoints:

```text
GET /api/doctors
GET /api/doctors/:id
GET /api/doctors/:id/slots?date=YYYY-MM-DD
```

## Slot Generation Rules

Generated slots must consider:

* doctor working day
* working start time
* working end time
* slot duration
* doctor leave
* already held slots
* already booked slots
* expired holds

Never present obviously invalid slots.

## Done When

Given configured working hours, the API returns the correct available slots.

---

# Milestone 6 — Slot Hold

## Goal

Temporarily reserve a selected slot before final confirmation.

Suggested endpoint:

```text
POST /api/appointments/hold
```

Suggested input:

```json
{
  "doctorId": "...",
  "startAt": "..."
}
```

Behavior:

1. validate doctor/date/time
2. confirm slot belongs to doctor's working schedule
3. confirm doctor is not on leave
4. attempt to create reservation
5. set approximately five-minute expiry
6. rely on database uniqueness for concurrency
7. return 409 if another valid reservation already owns the slot

Expired holds should no longer block availability.

Cleanup may happen through:

* worker
* scheduled cleanup
* transaction-safe lazy cleanup

Choose the simplest reliable approach.

## Done When

Two users cannot successfully hold the same slot simultaneously.

---

# Milestone 7 — Appointment Booking

## Goal

Convert a valid hold into a confirmed appointment.

Patient must submit symptoms before confirming.

Suggested endpoint:

```text
POST /api/appointments
```

Booking transaction should atomically handle important database state.

Recommended flow:

```text
validate user
validate hold ownership
validate hold expiry
validate doctor still available
create appointment
convert reservation HOLD -> BOOKED
create durable background jobs
commit
```

External APIs must not execute inside this transaction.

After commit, queue jobs such as:

* patient confirmation email
* doctor confirmation email
* pre-visit AI generation
* calendar event creation

## Concurrency Test

Create an automated test that launches several simultaneous attempts for the same doctor/time.

Target result:

```text
exactly 1 success
all remaining attempts fail cleanly
```

Competing requests should normally receive:

```text
409 Conflict
```

This is a critical project verification.

## Done When

The concurrency test proves double booking is prevented by the database-backed design.

---

# Milestone 8 — Appointment Views, Cancellation and Rescheduling

## Patient

Patient can view their appointments.

Suggested:

```text
GET /api/appointments/me
GET /api/appointments/:id
```

Patient can cancel their own valid appointment.

Suggested:

```text
DELETE /api/appointments/:id
```

Patient can reschedule.

Suggested:

```text
PATCH /api/appointments/:id/reschedule
```

Rescheduling should preserve the same booking safety principles.

Do not release the old appointment state before the replacement slot is safely acquired if that could create inconsistent behavior.

Generate appropriate outbox jobs for:

* cancellation email
* reschedule email
* calendar update/delete

## Done When

Booking, cancellation and rescheduling work without introducing double booking.

---

# Milestone 9 — Doctor Leave Conflict Handling

## Goal

Handle leave dates that conflict with existing appointments.

When admin creates leave:

1. create/validate leave
2. identify affected active appointments
3. cancel affected appointments
4. release associated booking state as appropriate
5. create patient notification jobs
6. create doctor notification jobs if required
7. create calendar cancellation jobs
8. commit database state
9. process external work asynchronously

All core database state changes should be transactionally consistent.

Consider race conditions between:

```text
Patient books doctor
```

and:

```text
Admin marks doctor on leave
```

Use appropriate transaction/constraint behavior.

## Done When

Creating leave with existing bookings results in deterministic cancellation and notification jobs without corrupting booking state.

---

# Milestone 10 — Pre-Visit AI Summary

## Goal

Generate useful structured information for the doctor from patient symptoms.

Target structure:

```json
{
  "urgency": "LOW | MEDIUM | HIGH",
  "chiefComplaint": "...",
  "suggestedQuestions": [
    "...",
    "...",
    "..."
  ]
}
```

Prompt principles:

* use only provided symptoms
* do not invent medical history
* urgency must be LOW, MEDIUM, or HIGH
* exactly three suggested questions
* output should be structured and validated

Store generated output in the database.

## Failure Behavior

If LLM fails:

* appointment remains BOOKED
* original symptoms remain available
* preSummaryStatus becomes FAILED
* doctor UI indicates AI summary unavailable
* workflow continues normally

Provide a mock/development provider if an API key is unavailable.

## Done When

Success and simulated failure cases both behave correctly.

---

# Milestone 11 — Doctor Visit Completion

## Goal

Doctor can complete the appointment.

Doctor view should display:

* patient
* appointment time
* symptoms
* AI pre-visit summary
* urgency
* suggested questions

Doctor can enter:

* clinical notes
* prescription information
* medication instructions
* follow-up instructions

Suggested endpoint:

```text
POST /api/doctor/appointments/:id/complete
```

Only the assigned doctor should be allowed to modify the appointment.

## Done When

Doctor can successfully submit visit data and complete the appointment.

---

# Milestone 12 — Post-Visit AI Summary

## Goal

Generate a patient-friendly explanation from doctor notes.

Target output should include:

* visit summary
* medication schedule
* follow-up steps

Prompt rules:

* do not invent diagnosis
* do not invent medications
* do not invent dosage
* do not invent instructions
* use only doctor-provided information

Persist generated result.

## Failure Behavior

If generation fails:

* doctor's clinical notes remain saved
* prescription remains saved
* appointment remains completed
* postSummaryStatus becomes FAILED
* workflow continues

## Done When

Patient can view a successful generated summary, while failure remains safe.

---

# Milestone 13 — Medication Reminders

## Goal

Create reminder schedules from prescriptions.

For each prescription, create relevant reminder records/jobs based on:

* frequency
* duration

Do not attempt an overly complex natural-language scheduling engine.

Support a sensible controlled representation for frequency.

Examples could include:

```text
ONCE_DAILY
TWICE_DAILY
THREE_TIMES_DAILY
```

or a similarly maintainable structure.

Worker finds due reminders and sends notification jobs.

Failures should be retried.

## Done When

Creating a prescription results in expected scheduled reminders.

---

# Milestone 14 — Email Notifications

## Goal

Send required email notifications through a reusable service.

Support:

* booking confirmation
* appointment reminder
* cancellation
* medication reminder

Prefer Nodemailer/SMTP for minimal setup unless another provider is chosen.

Use OutboxJob processing.

Example lifecycle:

```text
PENDING
   ↓
PROCESSING
   ↓
COMPLETED
```

Failure:

```text
PROCESSING
   ↓
FAILED / retry scheduled
```

Include retry tracking:

* attempts
* nextAttemptAt
* lastError

Do not make booking depend on email success.

Provide development/mock mode if SMTP credentials are unavailable.

## Done When

Email work is durable and failure does not invalidate appointments.

---

# Milestone 15 — Google Calendar Integration

## Goal

Synchronize appointments with Google Calendar using OAuth 2.0.

Required behaviors:

### Booking

Create calendar event.

### Reschedule

Update calendar event.

### Cancellation

Delete/cancel calendar event.

Store relevant event ID.

Use background/outbox jobs.

Do not make appointment creation depend on immediate Google API success.

If credentials or interactive OAuth consent are unavailable:

* implement the adapter
* implement mock/dev provider
* document real setup
* continue project

## Done When

Calendar integration architecture is complete and can operate in real or documented mock mode without breaking appointment state.

---

# Milestone 16 — Frontend Workflows

Do not spend excessive time on visual effects.

The UI must be clear, responsive, and professional enough for a hiring assignment.

## Public/Auth

Create:

* Login
* Patient registration

## Patient Dashboard

Create:

* doctor search
* specialization filter
* doctor details
* date selection
* available slots
* slot selection
* symptom form
* booking confirmation
* appointment list
* appointment details
* cancellation
* rescheduling
* post-visit summary
* prescription view

## Doctor Dashboard

Create:

* upcoming appointments
* appointment details
* symptoms
* urgency indicator
* AI pre-visit summary
* clinical notes form
* prescription form
* complete visit action

## Admin Dashboard

Create:

* doctor list
* create doctor
* edit doctor
* working-hours configuration
* slot-duration configuration
* leave management

## UX Requirements

Include:

* loading states
* useful error messages
* empty states
* HTTP 409 slot conflict handling
* failed AI summary fallback
* responsive basic layout

## Done When

The three roles can complete their required primary workflows through the UI.

---

# Milestone 17 — Critical Testing

Prioritize meaningful tests rather than chasing a large test count.

Required high-value scenarios:

1. patient registration/login
2. authentication protection
3. role authorization
4. doctor search/filter
5. slot generation
6. expired hold behavior
7. two patients racing for same slot
8. exactly one booking wins
9. doctor leave with existing bookings
10. cancellation
11. rescheduling
12. LLM success
13. LLM failure fallback
14. outbox retry behavior where practical
15. assigned-doctor authorization
16. appointment ownership authorization

Do not declare the project complete while critical tests fail.

---

# Milestone 18 — Documentation

README must include:

```text
# Healthcare Appointment & Follow-up Manager

## Live Demo

## Demo Credentials

## Features

## Architecture

## Tech Stack

## Project Structure

## Database Schema

## Local Setup

## Environment Variables

## Database Migration

## Seed Data

## Running the Application

## Running Tests

## API Documentation

## LLM Integration

## LLM Prompts

## Email Setup

## Google Calendar OAuth Setup

## Background Jobs

## Double-Booking Prevention

## Slot Hold Mechanism

## Doctor Leave Handling

## Notification Retry Strategy

## Deployment

## Known Limitations
```

Create:

```text
docs/system-design.md
```

Maximum:

```text
800 words
```

Required sections:

### Double-Booking Prevention

Explain:

* PostgreSQL uniqueness
* transactions
* conflict response
* DB as source of truth

### Slot Hold Mechanism

Explain:

* temporary HOLD
* expiry
* unique doctor/time
* confirmation
* cleanup

### Doctor Leave Conflict Handling

Explain:

* transaction
* affected appointments
* cancellations
* slot release
* outbox
* race protection

### Notification Failure Handling

Explain:

* durable outbox
* retries
* attempt counter
* nextAttemptAt
* external failure isolation

---

# Milestone 19 — Deployment Preparation

Prepare:

```text
.env.example
```

Potential variables:

```text
DATABASE_URL=
JWT_SECRET=

LLM_PROVIDER=
LLM_API_KEY=

SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=

CLIENT_URL=
SERVER_URL=
```

Do not expose real secrets.

Frontend should be suitable for deployment to a service such as Vercel.

Backend/database/worker should be suitable for deployment to a service such as Render, Railway, or equivalent.

---

# Milestone 20 — Final Verification

Before considering the assignment complete, verify:

* [ ] frontend builds
* [ ] backend builds
* [ ] database migrations work
* [ ] seed script works
* [ ] patient authentication works
* [ ] doctor authentication works
* [ ] admin authentication works
* [ ] RBAC is enforced
* [ ] admin can create/manage doctors
* [ ] doctor schedules work
* [ ] patients can filter doctors by specialization
* [ ] available slots generate correctly
* [ ] slot hold works
* [ ] expired hold is released
* [ ] database prevents double booking
* [ ] concurrency test proves one winner
* [ ] symptoms are stored
* [ ] pre-visit AI summary works
* [ ] pre-visit AI failure is safe
* [ ] doctor can submit notes
* [ ] doctor can create prescriptions
* [ ] post-visit AI summary works
* [ ] post-visit AI failure is safe
* [ ] medication reminders are created
* [ ] booking emails are queued/sent
* [ ] failed notifications can retry
* [ ] Google Calendar create path exists
* [ ] Google Calendar update path exists
* [ ] Google Calendar cancellation path exists
* [ ] doctor leave cancels affected appointments
* [ ] leave notifications are queued
* [ ] appointment cancellation works
* [ ] rescheduling works
* [ ] critical tests pass
* [ ] README matches actual project
* [ ] `.env.example` is complete
* [ ] no `.env` is committed
* [ ] no `node_modules` is committed
* [ ] no build artifacts are committed
* [ ] system-design document is at most 800 words
* [ ] IMPLEMENTATION_STATUS.md is current

---

# 5. Scope Control

Do not implement unless all required work is already stable:

* payments
* video consultation
* SMS
* live chat
* insurance workflows
* file uploads
* analytics dashboards
* multi-clinic support
* native mobile apps
* complex real-time systems

These are outside the assignment scope.

---

# 6. Implementation Status

Codex should maintain:

```text
IMPLEMENTATION_STATUS.md
```

Update it after meaningful milestones.

Use a structure similar to:

```text
# Implementation Status

## Current Milestone

## Completed

## In Progress

## Tests Passing

## Known Issues

## Blocked by Credentials / Human Action

## Next Action
```

This file should always reflect the real repository state.

---

# 7. Priority Order

If time becomes limited, prioritize in this exact order:

1. database/schema correctness
2. authentication and roles
3. safe booking
4. concurrency protection
5. slot hold
6. doctor leave conflict handling
7. patient/doctor core workflow
8. LLM summaries and failure handling
9. outbox/retries
10. email
11. Google Calendar
12. medication reminders
13. frontend polish
14. documentation
15. deployment polish

Never sacrifice booking correctness for visual polish.

---

# 8. Final Engineering Principle

The strongest demonstration of this project should be:

```text
The core healthcare booking system remains correct
even when users race for the same slot
or external services fail.
```

External APIs enhance the booking.

They do not define whether the booking exists.
