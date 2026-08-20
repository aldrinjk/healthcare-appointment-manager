# Healthcare Appointment & Follow-up Manager

Healthcare Appointment & Follow-up Manager is a technical hiring assignment project for a role-based healthcare booking MVP. The finished application will support patients, doctors, and admins with safe appointment booking, slot holds, AI summaries, prescriptions, reminders, email notifications, Google Calendar synchronization, and retryable background work.

Milestone 5 provides the runnable foundation, database schema, authentication/RBAC layer, admin doctor-management APIs, and patient-facing doctor discovery with slot generation: a React/Vite/TypeScript client, an Express/TypeScript server, Prisma configured for PostgreSQL, environment configuration, centralized JSON errors, a health endpoint, domain models, an initial migration, development seed data, JWT login, patient registration, role middleware, admin doctor creation/update/list/detail, availability management, leave record management, public doctor list/detail, and available appointment slots.

## Tech Stack

* React, Vite, TypeScript
* Node.js, Express, TypeScript
* PostgreSQL with Prisma ORM
* bcrypt password hashing
* JWT authentication
* npm workspaces

Business workflows, background job processing, LLM integration, email, and Google Calendar are planned for later milestones.

## Project Structure

```text
client/   React + Vite frontend
server/   Express API, Prisma configuration, backend source
docs/     Project documentation added in later milestones
```

## Environment Variables

Copy `.env.example` values into your local environment or `server/.env` when running server-side Prisma commands locally. Do not commit `.env` files.

Current variables:

* `PORT` - API server port, defaults to `4000`
* `CLIENT_URL` - frontend origin allowed by CORS
* `DATABASE_URL` - PostgreSQL connection string used by Prisma
* `JWT_SECRET` - local secret used to sign and verify JWTs
* `VITE_API_URL` - client API base URL

The remaining variables in `.env.example` are placeholders for future milestones and contain no real credentials.

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

Milestone 4 creates and removes leave records only. Appointment cancellation caused by doctor leave is intentionally deferred to Milestone 9.

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

## Timezone Assumption

For the current assignment scope, the application uses one scheduling timezone: UTC. Date query parameters such as `2026-09-21` are interpreted as UTC calendar dates, and configured availability times such as `09:00` are interpreted as UTC times on that date. Multi-timezone clinic/provider scheduling is intentionally deferred.

## Current Limitations

Milestone 5 does not include slot hold creation, appointment booking APIs, rescheduling, cancellation, leave-triggered appointment cancellation, LLM integration, email, Google Calendar, or background job processing. Those are scheduled in later milestones in `PROJECT_PLAN.md`.
