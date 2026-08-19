# Healthcare Appointment & Follow-up Manager — Agent Instructions

## Project Goal

Build a complete, deployable Healthcare Appointment & Follow-up Manager for a technical hiring assignment.

The application has three roles:

* PATIENT
* DOCTOR
* ADMIN

The system must prioritize correctness, reliability, clean architecture, and completion of assignment requirements over unnecessary features.

## Required Technology Stack

Use:

* React
* Vite
* TypeScript
* Node.js
* Express
* PostgreSQL
* Prisma ORM
* JWT authentication
* bcrypt password hashing
* Zod where useful for request validation

Keep dependencies minimal.

Do not introduce Redis, Kafka, GraphQL, Firebase, WebSockets, microservices, Kubernetes, or other infrastructure unless explicitly requested.

## Core Architecture Principle

PostgreSQL is the source of truth.

A booking must not depend on an external API being available.

External services such as:

* LLM provider
* email provider
* Google Calendar

must not be required for the database transaction that confirms an appointment.

External failures must not corrupt or roll back an already committed appointment.

## Project Structure

Prefer:

```text
client/
server/
docs/
```

Backend business logic should be organized into:

```text
controllers/
routes/
services/
middleware/
jobs/
integrations/
utils/
```

Keep controllers thin.

Put business rules in services.

Keep third-party integrations behind dedicated service modules or adapters.

## Required Domain Models

The database should support at minimum:

* User
* DoctorProfile
* DoctorAvailability
* DoctorLeave
* Appointment
* SlotReservation
* Prescription
* MedicationReminder
* OutboxJob

Use enums where appropriate for:

* user roles
* appointment status
* reservation status
* job status
* AI summary status
* urgency level

## Authentication and Authorization

Implement role-based access control.

PATIENT capabilities include:

* register and login
* search doctors
* filter by specialization
* view available slots
* hold a slot
* submit symptoms
* book an appointment
* cancel or reschedule their appointment
* view post-visit summaries and prescriptions

DOCTOR capabilities include:

* login
* view their appointments
* view patient symptoms
* view AI pre-visit summaries
* enter clinical notes
* enter prescriptions
* complete appointments
* generate patient-friendly post-visit summaries

ADMIN capabilities include:

* login
* create and manage doctor profiles
* manage specialization
* manage working hours
* manage slot duration
* manage doctor leave

Never trust the frontend for authorization.

Authorization must be enforced by backend middleware and services.

## Double-Booking Prevention

This is a critical evaluation requirement.

Never rely only on:

```text
check availability
then insert appointment
```

because simultaneous requests can race.

Use PostgreSQL constraints and transactions to guarantee that the same doctor and start time cannot be reserved by multiple patients.

The database must contain an appropriate uniqueness constraint for active slot reservations.

When simultaneous users attempt the same slot:

* exactly one should win
* competing requests should receive HTTP 409 Conflict

Add an automated concurrency test for this behavior.

## Slot Hold Mechanism

Implement a temporary slot hold.

Recommended behavior:

* patient selects a slot
* system creates a HOLD reservation
* hold expires after approximately 5 minutes
* booking confirmation converts the reservation to BOOKED
* expired holds become available again

The hold mechanism must still obey database-level concurrency protection.

## Doctor Leave

When an admin marks a doctor as unavailable for a date:

* create the leave record
* identify affected active appointments
* cancel affected appointments
* release applicable reservations
* create notification jobs
* create calendar synchronization jobs

Database state changes should be transactional.

Do not call external APIs inside the transaction.

Booking and leave operations must be designed to avoid race-condition inconsistencies.

## LLM Integration

The system requires two AI workflows.

### Pre-Visit Summary

Input:

Patient symptoms.

Structured result should contain:

* urgency: LOW, MEDIUM, or HIGH
* chief complaint
* exactly three suggested questions for the doctor

The model must not invent medical history.

Store AI output in the database.

### Post-Visit Summary

Input:

Doctor clinical notes and prescription information.

Generate:

* patient-friendly visit summary
* medication schedule
* follow-up steps

Do not invent diagnoses, medications, doses, or medical instructions that are not present in the doctor's notes.

## LLM Failure Handling

LLM failure must never break appointment workflows.

If generation fails:

* preserve the original symptoms or clinical notes
* store a FAILED summary status
* allow the rest of the workflow to continue
* expose a useful fallback message in the UI

If no real LLM API key is available during development, provide a clean mock/development provider so the application remains testable.

## Notifications and Background Work

Use a durable OutboxJob or equivalent database-backed job mechanism for asynchronous work.

Jobs may include:

* patient booking confirmation
* doctor booking confirmation
* appointment reminders
* cancellation notifications
* Google Calendar creation
* Google Calendar update
* Google Calendar deletion
* medication reminders
* AI processing where appropriate

Store information such as:

* type
* payload
* status
* attempts
* nextAttemptAt
* lastError
* createdAt
* updatedAt

Failed jobs should be retryable.

Do not mark an appointment as failed merely because an email, LLM call, or calendar API request failed.

## Medication Reminders

Prescriptions should support medication reminder scheduling based on frequency and duration.

Create reminder records or jobs that can be processed asynchronously.

Failed reminder delivery should be retryable.

## Email

Use a minimal email integration such as Nodemailer/SMTP unless another provider is explicitly selected.

Support:

* booking confirmation
* appointment reminder
* cancellation notification
* medication reminder

Never commit real email credentials.

## Google Calendar

Integrate Google Calendar through OAuth 2.0.

Booking should create the appropriate calendar event.

Rescheduling should update it.

Cancellation should remove or cancel it.

Store the Google event identifier with the appointment or related synchronization record.

If OAuth credentials are unavailable during development:

* keep the adapter/interface implemented
* provide development/mock behavior
* document remaining setup
* continue implementing unrelated functionality

## API Design

Use REST APIs and appropriate HTTP status codes.

Examples:

* 200 OK
* 201 Created
* 400 Bad Request
* 401 Unauthorized
* 403 Forbidden
* 404 Not Found
* 409 Conflict
* 500 Internal Server Error

Return consistent JSON error structures.

## Testing Priorities

Prioritize tests for high-risk behavior.

At minimum test:

* authentication
* role authorization
* doctor availability
* slot holding
* simultaneous booking attempts
* expired slot holds
* doctor leave conflict handling
* appointment cancellation/rescheduling
* LLM failure fallback
* outbox retry behavior where practical

A particularly important concurrency test should launch multiple simultaneous requests for the same doctor and start time and verify exactly one successful booking.

## Documentation

Maintain a high-quality README containing:

* project overview
* features
* architecture
* tech stack
* setup instructions
* environment variables
* `.env.example`
* database setup and migrations
* API documentation
* database schema explanation
* LLM prompts
* Google Calendar OAuth setup
* background-job explanation
* demo credentials if appropriate
* deployment instructions
* known limitations

Also maintain:

```text
docs/system-design.md
```

The system-design write-up must stay within 800 words and focus on:

1. double-booking prevention
2. doctor leave conflict handling
3. slot hold mechanism
4. notification failure handling

## Git and Submission Rules

The final project should be suitable for a public GitHub repository.

Main branch:

```text
main
```

Never commit:

```text
node_modules/
.env
.env.local
dist/
.next/
out/
.vscode/
.idea/
*.log
```

Commit:

```text
.env.example
```

Never place real API keys, passwords, tokens, OAuth secrets, or database credentials in source control.

## Development Rules

Before making major changes:

1. inspect existing code
2. understand the current implementation
3. preserve working behavior
4. make the smallest coherent change

After meaningful changes:

1. run relevant tests
2. run TypeScript/build checks
3. fix failures
4. update implementation status when appropriate

Do not claim something works without verification.

Do not silently remove requested functionality to make tests pass.

Do not add unrelated features.

Favor a reliable working MVP over unnecessary sophistication.

## If Blocked

If work requires credentials, OAuth approval, deployment access, or another human-only action:

1. clearly document the blocker
2. implement everything possible around it
3. provide mock/development behavior where reasonable
4. continue with other milestones

Do not stop the entire project because one external integration is unavailable.

## Completion Standard

A feature is not complete merely because code exists.

It is complete when the implementation is reasonably verified through builds, tests, or an executable workflow.
