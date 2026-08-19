# Healthcare Appointment & Follow-up Manager

Healthcare Appointment & Follow-up Manager is a technical hiring assignment project for a role-based healthcare booking MVP. The finished application will support patients, doctors, and admins with safe appointment booking, slot holds, AI summaries, prescriptions, reminders, email notifications, Google Calendar synchronization, and retryable background work.

Milestone 2 provides the runnable foundation and database schema: a React/Vite/TypeScript client, an Express/TypeScript server, Prisma configured for PostgreSQL, environment configuration, centralized JSON errors, a health endpoint, domain models, an initial migration, and development seed data.

## Tech Stack

* React, Vite, TypeScript
* Node.js, Express, TypeScript
* PostgreSQL with Prisma ORM
* bcrypt password hashing for seeded development users
* npm workspaces

JWT authentication endpoints, business workflows, background job processing, LLM integration, email, and Google Calendar are planned for later milestones.

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

## API

### `GET /api/health`

Returns:

```json
{
  "status": "ok"
}
```

## Current Limitations

Milestone 2 does not include authentication endpoints, authorization middleware, appointment booking APIs, business workflows, automated tests, LLM integration, email, Google Calendar, or background job processing. Those are scheduled in later milestones in `PROJECT_PLAN.md`.
