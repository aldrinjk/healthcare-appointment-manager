# Healthcare Appointment & Follow-up Manager

Healthcare Appointment & Follow-up Manager is a technical hiring assignment project for a role-based healthcare booking MVP. The finished application will support patients, doctors, and admins with safe appointment booking, slot holds, AI summaries, prescriptions, reminders, email notifications, Google Calendar synchronization, and retryable background work.

Milestone 1 provides the runnable foundation only: a React/Vite/TypeScript client, an Express/TypeScript server, Prisma configured for PostgreSQL, environment configuration, centralized JSON errors, and a health endpoint.

## Tech Stack

* React, Vite, TypeScript
* Node.js, Express, TypeScript
* PostgreSQL with Prisma ORM
* npm workspaces

JWT authentication, bcrypt, domain models, background jobs, LLM integration, email, and Google Calendar are planned for later milestones.

## Project Structure

```text
client/   React + Vite frontend
server/   Express API, Prisma configuration, backend source
docs/     Project documentation added in later milestones
```

## Environment Variables

Copy `.env.example` values into your local environment or a local `.env` file when needed. Do not commit `.env`.

Current Milestone 1 variables:

* `PORT` - API server port, defaults to `4000`
* `CLIENT_URL` - frontend origin allowed by CORS
* `DATABASE_URL` - PostgreSQL connection string used by Prisma
* `VITE_API_URL` - client API base URL

The remaining variables in `.env.example` are placeholders for future milestones and contain no real credentials.

## Install

```bash
npm install
```

## Prisma

Prisma is configured for PostgreSQL in `server/prisma/schema.prisma`. Milestone 1 intentionally does not define domain models yet.

Generate the Prisma client:

```bash
npm run prisma:generate
```

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

Milestone 1 does not include authentication, domain models, migrations, seed data, appointment workflows, tests, LLM integration, email, Google Calendar, or background jobs. Those are scheduled in later milestones in `PROJECT_PLAN.md`.
