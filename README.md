# Healthcare Appointment & Follow-up Manager

Healthcare Appointment & Follow-up Manager is a technical hiring assignment project for a role-based healthcare booking MVP. The finished application will support patients, doctors, and admins with safe appointment booking, slot holds, AI summaries, prescriptions, reminders, email notifications, Google Calendar synchronization, and retryable background work.

Milestone 14 provides the runnable foundation, database schema, authentication/RBAC layer, admin doctor-management APIs, patient-facing doctor discovery with slot generation, patient slot holds, appointment booking confirmation, patient appointment views, cancellation, rescheduling, doctor leave conflict handling, pre-visit AI summary processing, doctor visit completion, post-visit AI summary processing, deterministic medication reminder scheduling, and async email notification/retry handling: a React/Vite/TypeScript client, an Express/TypeScript server, Prisma configured for PostgreSQL, environment configuration, centralized JSON errors, a health endpoint, domain models, migrations, development seed data, JWT login, patient registration, role middleware, admin doctor creation/update/list/detail, availability management, leave conflict handling, public doctor list/detail, available appointment slots, temporary hold reservations, transactional hold-to-appointment confirmation, symptom storage, durable booking outbox jobs, safe patient appointment retrieval, transactional cancellation, transactional rescheduling, directly invokable `PRE_VISIT_SUMMARY` and `POST_VISIT_SUMMARY` outbox job handlers, doctor appointment list/detail APIs, transactional visit completion with prescriptions, persisted medication reminder records, email provider adapters, email templates, appointment reminder outbox scheduling, medication reminder email delivery, and a one-cycle email worker script.

## Tech Stack

* React, Vite, TypeScript
* Node.js, Express, TypeScript
* PostgreSQL with Prisma ORM
* bcrypt password hashing
* JWT authentication
* npm workspaces

Google Calendar API calls and frontend dashboards are planned for later milestones. Pre-visit and post-visit AI summary processing are implemented as outbox job handlers that future worker code can invoke. Email notification processing is implemented for a one-cycle worker; local development and automated tests use the mock email provider unless SMTP settings are configured.

## Project Structure

```text
client/   React + Vite frontend
server/   Express API, Prisma configuration, backend source
docs/     System design and project documentation
```

## Environment Variables

Copy `.env.example` values into your local environment or `server/.env` when running server-side Prisma commands locally. Do not commit `.env` files.

Current variables:

* `PORT` - API server port, defaults to `4000`
* `CLIENT_URL` - frontend origin allowed by CORS
* `DATABASE_URL` - PostgreSQL connection string used by Prisma
* `JWT_SECRET` - local secret used to sign and verify JWTs
* `LLM_PROVIDER` - `mock` for deterministic local/test summaries or `openai` for the OpenAI adapter
* `LLM_MODEL` - model name used by the OpenAI adapter, defaults to `gpt-4o-mini`
* `LLM_API_KEY` - local-only OpenAI API key when `LLM_PROVIDER=openai`
* `EMAIL_PROVIDER` - `mock` for deterministic local/test email delivery or `smtp` for the Nodemailer SMTP adapter
* `SMTP_HOST` - SMTP host used only when `EMAIL_PROVIDER=smtp`
* `SMTP_PORT` - SMTP port used only when `EMAIL_PROVIDER=smtp`
* `SMTP_USER` - local-only SMTP username used only when `EMAIL_PROVIDER=smtp`
* `SMTP_PASS` - local-only SMTP password used only when `EMAIL_PROVIDER=smtp`
* `SMTP_FROM` - sender address used by notification emails
* `VITE_API_URL` - client API base URL

All values in `.env.example` are safe placeholders and contain no real credentials.

## Install

```bash
npm install
```

## Database Schema

Prisma is configured for PostgreSQL in `server/prisma/schema.prisma`. The current schema includes:

* `User`
* `DoctorProfile`
* `DoctorAvailability`
* `DoctorLeave`
* `Appointment`
* `SlotReservation`
* `Prescription`
* `MedicationReminder`
* `OutboxJob`

The migration also creates a PostgreSQL partial unique index named `SlotReservation_active_doctor_start_key` on active slot reservations. It protects `(doctorId, startAt)` when reservation status is `HOLD` or `BOOKED`, which is the database foundation for later double-booking prevention.

Medication reminders are protected by a database-level unique constraint on `(prescriptionId, scheduledAt)` so scheduling the same prescription twice cannot duplicate the same dose reminder.

## Database Migration

Generate the Prisma client:

```bash
npm run prisma:generate
```

Validate the schema:

```bash
npm run prisma:validate
```

Apply migrations:

```bash
npm run db:migrate
```

## Seed Data

Seed development records:

```bash
npm run db:seed
```

The seed creates one admin, one patient, three doctors with different specializations, and weekday availability schedules for each doctor.

Development-only credentials:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `Password123!` |
| Patient | `patient@example.com` | `Password123!` |
| Doctor | `maya.patel@example.com` | `Password123!` |
| Doctor | `noah.williams@example.com` | `Password123!` |
| Doctor | `aisha.khan@example.com` | `Password123!` |

These credentials are for local/development use only. The database stores bcrypt password hashes.

## Run

Start the backend:

```bash
npm run dev:server
```

Start the frontend:

```bash
npm run dev:client
```

Default local URLs:

* Frontend: `http://localhost:5173`
* Backend health check: `http://localhost:4000/api/health`

## Build and Type Check

Build the frontend:

```bash
npm run build:client
```

Compile/type-check the backend:

```bash
npm run typecheck:server
npm run build:server
```

Run backend tests:

```bash
npm run test:server
```

## API

### `GET /api/health`

Returns:

```json
{
  "status": "ok"
}
```

### `POST /api/auth/register`

Public patient registration. Creates `PATIENT` users only.

Required JSON body:

```json
{
  "name": "Patient Name",
  "email": "patient@example.com",
  "password": "Password123!"
}
```

### `POST /api/auth/login`

Authenticates an existing user and returns a signed JWT plus safe user data.

Required JSON body:

```json
{
  "email": "patient@example.com",
  "password": "Password123!"
}
```

### `GET /api/auth/me`

Requires an `Authorization: Bearer <token>` header and returns the authenticated user without `passwordHash`.

### Admin Doctor Management

All admin doctor-management endpoints require `Authorization: Bearer <token>` for an authenticated admin user. Authenticated non-admin users receive `403`; unauthenticated requests receive `401`.

Implemented endpoints:

* `GET /api/admin/doctors`
* `POST /api/admin/doctors`
* `GET /api/admin/doctors/:id`
* `PATCH /api/admin/doctors/:id`
* `POST /api/admin/doctors/:id/availability`
* `POST /api/admin/doctors/:id/leave`
* `DELETE /api/admin/doctors/:id/leave/:leaveId`

Create doctor request:

```json
{
  "name": "Dr. Example",
  "email": "doctor@example.com",
  "password": "Password123!",
  "specialization": "Cardiology",
  "slotDuration": 30
}
```

Update doctor request supports safe fields only:

```json
{
  "name": "Dr. Updated",
  "specialization": "Dermatology",
  "slotDuration": 20
}
```

Create availability request:

```json
{
  "weekday": "MONDAY",
  "startTime": "09:00",
  "endTime": "17:00"
}
```

Create leave request:

```json
{
  "date": "2026-09-15",
  "reason": "Conference"
}
```

Creating leave now runs in a serializable transaction. If the doctor already has `BOOKED` appointments on that UTC date, the leave transaction:

* creates the `DoctorLeave`
* marks affected `BOOKED` appointments as `CANCELLED`
* releases linked `BOOKED` reservations as `RELEASED`
* creates three durable `PENDING` outbox jobs per affected appointment:
  * `DOCTOR_LEAVE_CANCELLATION_PATIENT`
  * `DOCTOR_LEAVE_CANCELLATION_DOCTOR`
  * `CALENDAR_DELETE`

Already `CANCELLED` and `COMPLETED` appointments are not cancelled again. Duplicate leave creation returns `409` and does not create duplicate cancellation jobs.

Deleting leave removes only the leave record. It does not restore appointments or reservations that were cancelled because of that leave.

### Public Doctor Discovery

These endpoints are public and return safe doctor/profile data only. They do not expose `passwordHash` or private authentication fields.

Implemented endpoints:

* `GET /api/doctors`
* `GET /api/doctors?specialization=Cardiology`
* `GET /api/doctors/:id`
* `GET /api/doctors/:id/slots?date=YYYY-MM-DD`

Slot responses use UTC ISO timestamps:

```json
{
  "date": "2026-09-21",
  "timeZone": "UTC",
  "slots": [
    {
      "startAt": "2026-09-21T09:00:00.000Z",
      "endAt": "2026-09-21T09:30:00.000Z"
    }
  ]
}
```

Slot generation considers the doctor's weekday availability, slot duration, leave records, active `HOLD` reservations, `BOOKED` reservations, non-cancelled appointments, expired holds, and past times.

### Slot Holds

`POST /api/appointments/hold` requires a patient Bearer token. Doctors and admins receive `403`; unauthenticated requests receive `401`.

Request:

```json
{
  "doctorId": "doctor-profile-id",
  "startAt": "2026-09-21T09:00:00.000Z"
}
```

Successful response:

```json
{
  "reservation": {
    "id": "reservation-id",
    "doctorId": "doctor-profile-id",
    "startAt": "2026-09-21T09:00:00.000Z",
    "expiresAt": "2026-09-21T09:05:00.000Z",
    "status": "HOLD"
  }
}
```

Holds expire after approximately five minutes. The service lazily marks expired conflicting holds as `EXPIRED` before attempting a replacement hold, then relies on the PostgreSQL partial unique index on active slot reservations to choose the winner under race conditions. If the same patient requests a slot they already actively hold, the API returns the existing reservation with HTTP `200`.

### Appointment Booking

`POST /api/appointments` requires a patient Bearer token. Doctors and admins receive `403`; unauthenticated requests receive `401`.

Request:

```json
{
  "reservationId": "held-reservation-id",
  "symptoms": "Persistent cough and mild fever."
}
```

Successful response:

```json
{
  "appointment": {
    "id": "appointment-id",
    "doctorId": "doctor-profile-id",
    "startAt": "2026-09-21T09:00:00.000Z",
    "endAt": "2026-09-21T09:30:00.000Z",
    "status": "BOOKED",
    "symptoms": "Persistent cough and mild fever.",
    "preSummaryStatus": "PENDING"
  }
}
```

Booking converts a patient-owned, unexpired `HOLD` reservation into one `BOOKED` appointment inside a single Prisma transaction. The transaction also links the reservation to the appointment and creates five durable `PENDING` outbox jobs:

* `BOOKING_CONFIRMATION_PATIENT`
* `BOOKING_CONFIRMATION_DOCTOR`
* `PRE_VISIT_SUMMARY`
* `CALENDAR_CREATE`
* `APPOINTMENT_REMINDER_PATIENT`

No email provider, LLM provider, or Google Calendar API is called inside the booking transaction. External processing is deferred to future workers so provider failures cannot roll back an already committed appointment.

Repeated confirmation of an already-booked patient-owned reservation returns the existing appointment and does not create duplicate appointments or duplicate outbox jobs.

### Patient Appointment Views

These endpoints require a patient Bearer token. Doctors and admins receive `403`; unauthenticated requests receive `401`.

Implemented endpoints:

* `GET /api/appointments/me`
* `GET /api/appointments/:id`

The list endpoint returns only the authenticated patient's appointments sorted by `startAt`. Appointment responses include safe doctor/profile information, status, `startAt`, `endAt`, symptoms, summary statuses, follow-up instructions/post-visit summary data if present, and prescription data if present. They do not expose `passwordHash`, patient email, doctor email, or unrelated users' appointments.

### Appointment Cancellation

`DELETE /api/appointments/:id` requires a patient Bearer token and only cancels that patient's own `BOOKED` appointments.

Cancellation runs in one Prisma transaction:

* marks the appointment `CANCELLED`
* records `cancelledAt`
* releases the linked `BOOKED` slot reservation by changing it to `RELEASED`
* creates three durable `PENDING` outbox jobs:
  * `CANCELLATION_CONFIRMATION_PATIENT`
  * `CANCELLATION_NOTIFICATION_DOCTOR`
  * `CALENDAR_DELETE`

Completed or already-cancelled appointments return `409` and do not create duplicate cancellation jobs.

### Appointment Rescheduling

`PATCH /api/appointments/:id/reschedule` requires a patient Bearer token.

Request:

```json
{
  "newReservationId": "new-held-reservation-id"
}
```

The new reservation must be a patient-owned, active, unexpired `HOLD`. The service revalidates the new slot against the doctor's UTC schedule, leave records, and existing appointment conflicts. Rescheduling to a different doctor is allowed when the new held slot is valid; the appointment's `doctorId`, `startAt`, and `endAt` are updated accordingly.

Rescheduling runs in one Prisma transaction with guarded reservation updates:

* validates the existing appointment and new hold
* updates the appointment to the new doctor/time
* converts the new reservation to `BOOKED` and links it to the appointment
* releases the old `BOOKED` reservation as `RELEASED`
* creates three durable `PENDING` outbox jobs:
  * `RESCHEDULE_CONFIRMATION_PATIENT`
  * `RESCHEDULE_NOTIFICATION_DOCTOR`
  * `CALENDAR_UPDATE`

The old booking is not released outside the transaction. If any step fails, PostgreSQL rolls the appointment, old reservation, new hold, and outbox jobs back together. Repeating the same reschedule request with the already-booked reservation returns the existing appointment without duplicating booking state or outbox jobs. Concurrent competing reschedules are guarded by reservation state checks; conflicting attempts receive `409`.

Once a reschedule outbox job set exists for an appointment, additional competing reschedule requests using different holds receive `409`. This keeps a simultaneous competing reschedule race from creating multiple final booking states or duplicate reschedule notification/calendar jobs. Repeating the already-booked reservation remains idempotent.

### Doctor Leave Conflict Handling

Doctor leave uses UTC calendar dates, matching the project's scheduling assumption. Booking confirmation also runs under serializable isolation and rechecks doctor leave inside the transaction. This protects the critical race between a patient confirming a slot and an admin creating leave for the same doctor/date:

* if leave commits first, booking fails cleanly because the held slot is no longer valid
* if booking commits first, leave creation cancels the new appointment and releases its reservation
* the final database state must not contain both a leave record and an active `BOOKED` appointment for that doctor/date

No email or Google Calendar API is called inside the leave transaction; external work is represented only by durable outbox jobs.

### Pre-Visit AI Summary

Booking creates a durable `PRE_VISIT_SUMMARY` outbox job. Milestone 10 implements the job handler service that a future worker can invoke directly; it does not expose a public job-execution endpoint.

Logical persisted summary shape:

```json
{
  "urgency": "LOW",
  "chiefComplaint": "Persistent cough and fever",
  "suggestedQuestions": [
    "When did these symptoms start?",
    "Have the symptoms changed or worsened since they began?",
    "What makes the symptoms better or worse?"
  ]
}
```

The structured provider output is validated before saving. On success, the service:

* preserves the original `symptoms`
* stores the structured JSON in `Appointment.preVisitSummary`
* stores urgency in `Appointment.urgency`
* sets `preSummaryStatus` to `COMPLETED`
* marks the `PRE_VISIT_SUMMARY` job `COMPLETED`

On provider failure, timeout, malformed output, invalid urgency, or any question-count mismatch, the appointment remains `BOOKED`, original symptoms remain available, `preSummaryStatus` becomes `FAILED`, and the outbox job records a safe retryable failure message.

Current provider modes:

* `LLM_PROVIDER=mock` - deterministic development/test provider; no API key or network required.
* `LLM_PROVIDER=openai` - OpenAI adapter using `LLM_MODEL` and local-only `LLM_API_KEY`.

The pre-visit prompt is kept in `server/src/integrations/llm/prompts.ts`. It instructs the provider to return structured data only, use urgency `LOW`, `MEDIUM`, or `HIGH`, include a chief complaint and exactly three suggested questions, and not invent medical history, diagnoses, medications, or certainty.

### Doctor Appointment Views

These endpoints require a doctor Bearer token. Patients and admins receive `403`; unauthenticated requests receive `401`.

Implemented endpoints:

* `GET /api/doctor/appointments`
* `GET /api/doctor/appointments/:id`

Doctor appointment responses include only appointments assigned to the authenticated doctor's profile. Another doctor receives `404` for an appointment they do not own. Responses include patient-safe identity data, appointment time, status, symptoms, urgency, `preVisitSummary`, `preSummaryStatus`, clinical notes, follow-up instructions, post-summary status, and prescriptions when present. They do not expose `passwordHash`, patient email, or unrelated account fields.

If `preSummaryStatus` is `FAILED`, the response keeps the original symptoms and includes:

```text
AI summary unavailable. Original patient symptoms remain available.
```

### Doctor Visit Completion

`POST /api/doctor/appointments/:id/complete` requires the assigned doctor. Patients/admins receive `403`; a different doctor receives `404`.

Request:

```json
{
  "clinicalNotes": "Patient examined. Findings consistent with reported symptoms.",
  "followUpInstructions": "Return if symptoms worsen or do not improve.",
  "prescriptions": [
    {
      "medicine": "Amoxicillin",
      "dosage": "500mg",
      "frequency": "TWICE_DAILY",
      "durationDays": 5,
      "instructions": "Take after food"
    }
  ]
}
```

Supported prescription frequency values come from the Prisma `PrescriptionFrequency` enum:

* `ONCE_DAILY`
* `TWICE_DAILY`
* `THREE_TIMES_DAILY`
* `AS_NEEDED`

Completion runs in one PostgreSQL serializable transaction:

* verifies the authenticated doctor owns the appointment
* requires appointment status `BOOKED`
* rejects `CANCELLED` or already `COMPLETED` appointments with `409`
* stores clinical notes and follow-up instructions
* creates one or more prescription records
* creates deterministic medication reminder records for the prescriptions
* marks the appointment `COMPLETED`
* sets `postSummaryStatus` to `PENDING`
* creates exactly one durable `POST_VISIT_SUMMARY` outbox job

The `POST_VISIT_SUMMARY` payload contains the appointment identifier only. No post-visit LLM call runs inside the doctor request; post-visit summary generation is handled by the durable job processor described below.

### Medication Reminders

Medication reminders are generated from doctor-entered `Prescription` rows only. AI is not used for reminder scheduling.

Supported prescription frequency values and UTC reminder times:

| Frequency | Reminder times |
| --- | --- |
| `ONCE_DAILY` | `09:00` UTC |
| `TWICE_DAILY` | `09:00`, `21:00` UTC |
| `THREE_TIMES_DAILY` | `09:00`, `15:00`, `21:00` UTC |
| `AS_NEEDED` | no automatic scheduled reminders |

Reminder generation starts from the UTC calendar date of visit completion. Any scheduled time before the completion timestamp on that first day is skipped; a dose exactly at the completion timestamp is retained. Later dates are generated through `durationDays`, and no reminders are created beyond that duration.

Doctor visit completion creates prescription rows, medication reminder rows, and the `POST_VISIT_SUMMARY` outbox job inside the same PostgreSQL serializable transaction. If reminder generation fails, the whole completion rolls back: the appointment remains `BOOKED`, prescriptions do not partially persist, reminders do not partially persist, and no post-visit summary job is left behind.

Milestone 14 adds medication reminder email delivery for due reminders. A worker can claim due `PENDING` or retryable `FAILED` reminders where `scheduledAt <= now`; successful delivery marks the reminder `SENT`, while failure marks it `FAILED`, increments attempts, and leaves the prescription/appointment state unchanged. Future reminders, already `SENT` reminders, and `AS_NEEDED` prescriptions are not sent.

### Email Notifications and Retry Handling

Email delivery is isolated behind `server/src/integrations/email`. Domain services never call Nodemailer directly.

Implemented providers:

* `EMAIL_PROVIDER=mock` - deterministic in-memory provider for local development and automated tests; no network or credentials required.
* `EMAIL_PROVIDER=smtp` - Nodemailer SMTP adapter using local-only SMTP environment variables.

Implemented email templates cover:

* patient and doctor booking confirmations
* patient cancellation confirmation and doctor cancellation notification
* patient reschedule confirmation and doctor reschedule notification
* patient and doctor doctor-leave cancellation notices
* patient appointment reminders
* medication reminders

`processEmailOutboxJob(jobId)` handles email outbox jobs by atomically claiming due `PENDING` or retryable `FAILED` jobs as `PROCESSING`, sending through the configured provider, and then marking the job `COMPLETED` or `FAILED`. The bounded retry policy uses at most three attempts with deterministic backoff of approximately 1, 5, and 15 minutes. Completed jobs are idempotent and are not sent again. Provider error details are sanitized before being stored.

Booking creates an `APPOINTMENT_REMINDER_PATIENT` outbox job transactionally with the appointment. Reminder jobs are scheduled about 24 hours before the appointment. If the appointment is booked less than 24 hours ahead, the reminder is scheduled immediately. Cancellation deactivates pending reminder jobs, and rescheduling deactivates the old reminder and creates a new one for the updated appointment time.

Medication reminder delivery uses `MedicationReminder` rows directly. A due reminder is claimed as `PROCESSING`, sent through the email provider, and marked `SENT` on success. Delivery failure marks the reminder `FAILED`, increments attempts, and leaves the appointment and prescription data intact for retry.

Run one email-worker cycle after building the backend:

```bash
npm run build:server
npm run worker:email
```

The worker processes due email outbox jobs and due medication reminders once, then exits. It is intentionally not a long-running daemon yet.

### Post-Visit AI Summary

Doctor visit completion creates a durable `POST_VISIT_SUMMARY` outbox job. Milestone 12 implements `processPostVisitSummaryJob`, which can be invoked directly now and by a generic worker later.

Logical persisted summary shape:

```json
{
  "visitSummary": "Your doctor documented: findings consistent with reported symptoms.",
  "medicationSchedule": [
    {
      "medicine": "Amoxicillin",
      "dosage": "500mg",
      "frequency": "TWICE_DAILY",
      "durationDays": 5,
      "instructions": "Take after food"
    }
  ],
  "followUpSteps": [
    "Return if symptoms worsen or do not improve."
  ]
}
```

Medication data is authoritative from the database, not the LLM. The provider is asked only for patient-friendly explanatory text and follow-up steps; the saved `medicationSchedule` is constructed from persisted `Prescription` rows so the AI cannot add a medicine, change a dose, change frequency, change duration, or change instructions.

The post-visit prompt is kept in `server/src/integrations/llm/prompts.ts`. It instructs the provider to use only doctor notes, follow-up instructions, and prescription information; not invent diagnosis, medications, dosage, duration, instructions, or extra medical advice; preserve medically important meaning; use patient-friendly language; and return structured data only.

On success, the service:

* preserves the completed appointment status
* preserves clinical notes, follow-up instructions, and prescription rows
* stores structured JSON in `Appointment.postVisitSummary`
* sets `postSummaryStatus` to `COMPLETED`
* marks the `POST_VISIT_SUMMARY` job `COMPLETED`

On provider failure, timeout, malformed output, or incomplete appointment data, the appointment remains `COMPLETED`, doctor-entered data is preserved, `postSummaryStatus` becomes `FAILED`, and the outbox job records a safe retryable failure. Patient/doctor appointment responses can expose this fallback when the post-summary failed:

```text
AI summary unavailable.
```

Current provider modes:

* `LLM_PROVIDER=mock` - deterministic development/test provider; no API key or network required.
* `LLM_PROVIDER=openai` - OpenAI adapter using `LLM_MODEL` and local-only `LLM_API_KEY`.

Completed `POST_VISIT_SUMMARY` jobs are idempotent: they do not call the provider again or overwrite an existing valid summary. Failed jobs can be retried and can later complete successfully without duplicating prescriptions.

## Timezone Assumption

For the current assignment scope, the application uses one scheduling timezone: UTC. Date query parameters such as `2026-09-21` are interpreted as UTC calendar dates, and configured availability times such as `09:00` are interpreted as UTC times on that date. Multi-timezone clinic/provider scheduling is intentionally deferred.

## Current Limitations

Milestone 14 does not include Google Calendar calls, a long-running daemon/scheduler, or frontend patient/doctor/admin dashboards. The SMTP adapter exists, but actual SMTP delivery requires local credentials and `EMAIL_PROVIDER=smtp`. Automated tests and local development use mock email mode by default. The OpenAI adapter exists for pre-visit and post-visit summaries, but automated tests and local development use mock LLM mode unless local OpenAI credentials are configured.
