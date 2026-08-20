import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  AiSummaryStatus,
  AppointmentStatus,
  MedicationReminderStatus,
  OutboxJobStatus,
  PrescriptionFrequency,
  Prisma,
  UserRole
} from "@prisma/client";

process.env.NODE_ENV = "test";

const [
  { prisma },
  { completeDoctorVisit, postVisitSummaryJobType },
  {
    buildMedicationReminderSchedule,
    createMedicationRemindersForPrescriptions,
    findDueMedicationReminders,
    getMedicationReminderTimesForFrequency,
    medicationReminderScheduleUtcByFrequency
  }
] = await Promise.all([
  import("../utils/prisma.js"),
  import("../services/doctor-appointment.service.js"),
  import("../services/medication-reminder.service.js")
]);

const userIds = new Set<string>();
const appointmentIds = new Set<string>();

type DoctorFixture = {
  userId: string;
  doctorProfileId: string;
};

function makeEmail(prefix: string) {
  return `${prefix}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
}

function dateUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function hhmm(date: Date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes()
  ).padStart(2, "0")}`;
}

function scheduleFor(
  frequency: PrescriptionFrequency,
  durationDays: number,
  completedAt = dateUtc(2035, 1, 1, 8)
) {
  return buildMedicationReminderSchedule(
    {
      id: `prescription-${frequency}-${durationDays}`,
      frequency,
      durationDays
    },
    completedAt
  );
}

function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveField);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, childValue]) =>
      key === "passwordHash" ||
      key === "email" ||
      key === "password" ||
      key === "JWT_SECRET" ||
      key === "LLM_API_KEY" ||
      containsSensitiveField(childValue)
  );
}

async function createPatient() {
  const user = await prisma.user.create({
    data: {
      name: "Medication Reminder Patient",
      email: makeEmail("medication.reminder.patient"),
      passwordHash: "test-password-hash",
      role: UserRole.PATIENT
    },
    select: {
      id: true
    }
  });

  userIds.add(user.id);

  return user;
}

async function createDoctor() {
  const user = await prisma.user.create({
    data: {
      name: "Medication Reminder Doctor",
      email: makeEmail("medication.reminder.doctor"),
      passwordHash: "test-password-hash",
      role: UserRole.DOCTOR,
      doctorProfile: {
        create: {
          specialization: "Medication Scheduling",
          slotDurationMinutes: 30
        }
      }
    },
    select: {
      id: true,
      doctorProfile: {
        select: {
          id: true
        }
      }
    }
  });

  userIds.add(user.id);
  assert.ok(user.doctorProfile);

  return {
    userId: user.id,
    doctorProfileId: user.doctorProfile.id
  };
}

async function createAppointment(
  doctor: DoctorFixture,
  options: {
    status?: AppointmentStatus;
    patientId?: string;
    startAt?: Date;
  } = {}
) {
  const patient =
    options.patientId === undefined ? await createPatient() : { id: options.patientId };
  const startAt = options.startAt ?? dateUtc(2035, 2, 1, 9 + appointmentIds.size);
  const appointment = await prisma.appointment.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.doctorProfileId,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      status: options.status ?? AppointmentStatus.BOOKED,
      symptoms: "Medication reminder test symptoms.",
      preSummaryStatus: AiSummaryStatus.PENDING,
      postSummaryStatus:
        options.status === AppointmentStatus.COMPLETED
          ? AiSummaryStatus.PENDING
          : AiSummaryStatus.NOT_REQUESTED,
      clinicalNotes:
        options.status === AppointmentStatus.COMPLETED
          ? "Completed visit notes."
          : null,
      followUpInstructions:
        options.status === AppointmentStatus.COMPLETED
          ? "Follow up if symptoms worsen."
          : null
    },
    select: {
      id: true
    }
  });

  appointmentIds.add(appointment.id);

  return appointment;
}

async function createPrescription(
  doctor: DoctorFixture,
  options: {
    frequency?: PrescriptionFrequency;
    durationDays?: number;
    medicineName?: string;
  } = {}
) {
  const appointment = await createAppointment(doctor, {
    status: AppointmentStatus.COMPLETED
  });

  const prescription = await prisma.prescription.create({
    data: {
      appointmentId: appointment.id,
      medicineName: options.medicineName ?? "Reminder Medicine",
      dosage: "10mg",
      frequency: options.frequency ?? PrescriptionFrequency.ONCE_DAILY,
      durationDays: options.durationDays ?? 2,
      instructions: "Take with water"
    },
    select: {
      id: true,
      frequency: true,
      durationDays: true,
      appointmentId: true
    }
  });

  return { appointment, prescription };
}

async function remindersForAppointment(appointmentId: string) {
  return prisma.medicationReminder.findMany({
    where: {
      prescription: {
        appointmentId
      }
    },
    orderBy: [{ scheduledAt: "asc" }, { prescriptionId: "asc" }]
  });
}

async function postVisitJobsForAppointment(appointmentId: string) {
  const jobs = await prisma.outboxJob.findMany({
    where: {
      type: postVisitSummaryJobType
    },
    select: {
      id: true,
      status: true,
      attempts: true,
      payload: true
    }
  });

  return jobs.filter((job) => {
    const payload = job.payload;

    return (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      "appointmentId" in payload &&
      payload.appointmentId === appointmentId
    );
  });
}

async function reminderCountForAppointment(appointmentId: string) {
  return prisma.medicationReminder.count({
    where: {
      prescription: {
        appointmentId
      }
    }
  });
}

async function prescriptionCountForAppointment(appointmentId: string) {
  return prisma.prescription.count({
    where: {
      appointmentId
    }
  });
}

after(async () => {
  if (appointmentIds.size > 0) {
    const jobs = await prisma.outboxJob.findMany({
      where: {
        type: postVisitSummaryJobType
      },
      select: {
        id: true,
        payload: true
      }
    });
    const jobIds = jobs
      .filter((job) => {
        const payload = job.payload;

        return (
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          "appointmentId" in payload &&
          typeof payload.appointmentId === "string" &&
          appointmentIds.has(payload.appointmentId)
        );
      })
      .map((job) => job.id);

    if (jobIds.length > 0) {
      await prisma.outboxJob.deleteMany({
        where: {
          id: {
            in: jobIds
          }
        }
      });
    }

    await prisma.appointment.deleteMany({
      where: {
        id: {
          in: [...appointmentIds]
        }
      }
    });
  }

  if (userIds.size > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [...userIds]
        }
      }
    });
  }

  await prisma.$disconnect();
});

describe("medication reminder scheduling", () => {
  test("ONCE_DAILY creates the correct number of reminders", () => {
    assert.equal(scheduleFor(PrescriptionFrequency.ONCE_DAILY, 3).length, 3);
  });

  test("TWICE_DAILY creates the correct number of reminders", () => {
    assert.equal(scheduleFor(PrescriptionFrequency.TWICE_DAILY, 2).length, 4);
  });

  test("THREE_TIMES_DAILY creates the correct number of reminders", () => {
    assert.equal(scheduleFor(PrescriptionFrequency.THREE_TIMES_DAILY, 2).length, 6);
  });

  test("AS_NEEDED creates zero scheduled reminders", () => {
    assert.equal(scheduleFor(PrescriptionFrequency.AS_NEEDED, 30).length, 0);
  });

  test("durationDays is respected", () => {
    const reminders = scheduleFor(PrescriptionFrequency.ONCE_DAILY, 4);

    assert.equal(reminders.length, 4);
    assert.deepEqual(
      reminders.map((reminder) => reminder.scheduledAt.toISOString()),
      [
        "2035-01-01T09:00:00.000Z",
        "2035-01-02T09:00:00.000Z",
        "2035-01-03T09:00:00.000Z",
        "2035-01-04T09:00:00.000Z"
      ]
    );
  });

  test("reminder times match the centralized UTC schedule", () => {
    assert.deepEqual(
      getMedicationReminderTimesForFrequency(
        PrescriptionFrequency.THREE_TIMES_DAILY
      ),
      medicationReminderScheduleUtcByFrequency.THREE_TIMES_DAILY
    );
    assert.deepEqual(
      scheduleFor(PrescriptionFrequency.THREE_TIMES_DAILY, 1).map((reminder) =>
        hhmm(reminder.scheduledAt)
      ),
      ["09:00", "15:00", "21:00"]
    );
  });

  test("ONCE_DAILY UTC schedule is 09:00", () => {
    assert.deepEqual(
      medicationReminderScheduleUtcByFrequency.ONCE_DAILY,
      ["09:00"]
    );
  });

  test("TWICE_DAILY UTC schedule is 09:00 and 21:00", () => {
    assert.deepEqual(
      medicationReminderScheduleUtcByFrequency.TWICE_DAILY,
      ["09:00", "21:00"]
    );
  });

  test("AS_NEEDED has no automatic UTC schedule", () => {
    assert.deepEqual(medicationReminderScheduleUtcByFrequency.AS_NEEDED, []);
  });

  test("no reminder falls outside prescription duration", () => {
    const reminders = scheduleFor(PrescriptionFrequency.THREE_TIMES_DAILY, 2);

    assert.ok(
      reminders.every(
        (reminder) =>
          reminder.scheduledAt >= dateUtc(2035, 1, 1, 0) &&
          reminder.scheduledAt <= dateUtc(2035, 1, 2, 21)
      )
    );
  });

  test("past reminder times on the first day are skipped", () => {
    const reminders = scheduleFor(
      PrescriptionFrequency.THREE_TIMES_DAILY,
      1,
      dateUtc(2035, 1, 1, 16)
    );

    assert.deepEqual(
      reminders.map((reminder) => reminder.scheduledAt.toISOString()),
      ["2035-01-01T21:00:00.000Z"]
    );
  });

  test("future first-day doses still generate correctly", () => {
    const reminders = scheduleFor(
      PrescriptionFrequency.TWICE_DAILY,
      1,
      dateUtc(2035, 1, 1, 8, 30)
    );

    assert.deepEqual(
      reminders.map((reminder) => reminder.scheduledAt.toISOString()),
      ["2035-01-01T09:00:00.000Z", "2035-01-01T21:00:00.000Z"]
    );
  });

  test("dose exactly at completion time is retained", () => {
    const reminders = scheduleFor(
      PrescriptionFrequency.ONCE_DAILY,
      1,
      dateUtc(2035, 1, 1, 9)
    );

    assert.deepEqual(
      reminders.map((reminder) => reminder.scheduledAt.toISOString()),
      ["2035-01-01T09:00:00.000Z"]
    );
  });

  test("reminders reference the correct prescription", () => {
    const reminders = buildMedicationReminderSchedule(
      {
        id: "prescription-authoritative-id",
        frequency: PrescriptionFrequency.TWICE_DAILY,
        durationDays: 1
      },
      dateUtc(2035, 1, 1, 8)
    );

    assert.ok(
      reminders.every(
        (reminder) => reminder.prescriptionId === "prescription-authoritative-id"
      )
    );
  });

  test("invalid prescription duration is rejected", () => {
    assert.throws(
      () =>
        buildMedicationReminderSchedule(
          {
            id: "invalid-duration",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 0
          },
          dateUtc(2035, 1, 1, 8)
        ),
      /Prescription duration must be positive/
    );
  });
});

describe("medication reminder visit completion integration", () => {
  test("completing a visit creates reminders atomically with prescriptions", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "Reminder integration clinical notes.",
        followUpInstructions: "Reminder integration follow-up.",
        prescriptions: [
          {
            medicine: "Daily Medicine",
            dosage: "10mg",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 2,
            instructions: "Take after breakfast"
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    assert.equal(await prescriptionCountForAppointment(appointment.id), 1);
    assert.equal(await reminderCountForAppointment(appointment.id), 2);
  });

  test("multiple prescriptions create independent reminder schedules", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "Multiple prescription notes.",
        followUpInstructions: "Multiple prescription follow-up.",
        prescriptions: [
          {
            medicine: "Daily Medicine",
            dosage: "10mg",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 2,
            instructions: "Morning"
          },
          {
            medicine: "Three Times Medicine",
            dosage: "5ml",
            frequency: PrescriptionFrequency.THREE_TIMES_DAILY,
            durationDays: 1,
            instructions: "After meals"
          },
          {
            medicine: "As Needed Medicine",
            dosage: "1 tablet",
            frequency: PrescriptionFrequency.AS_NEEDED,
            durationDays: 5,
            instructions: "Only if needed"
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    const prescriptions = await prisma.prescription.findMany({
      where: {
        appointmentId: appointment.id
      },
      include: {
        reminders: true
      }
    });
    const reminderCountsByMedicine = Object.fromEntries(
      prescriptions.map((prescription) => [
        prescription.medicineName,
        prescription.reminders.length
      ])
    );

    assert.equal(reminderCountsByMedicine["Daily Medicine"], 2);
    assert.equal(reminderCountsByMedicine["Three Times Medicine"], 3);
    assert.equal(reminderCountsByMedicine["As Needed Medicine"], 0);
  });

  test("appointment becomes COMPLETED when reminders persist", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "Completion status notes.",
        followUpInstructions: null,
        prescriptions: [
          {
            medicine: "Status Medicine",
            dosage: "10mg",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 1,
            instructions: null
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: appointment.id
      },
      select: {
        status: true
      }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.COMPLETED);
  });

  test("prescriptions and reminders persist with authoritative prescription data", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "Authoritative prescription notes.",
        followUpInstructions: null,
        prescriptions: [
          {
            medicine: "Authoritative Medicine",
            dosage: "20mg",
            frequency: PrescriptionFrequency.TWICE_DAILY,
            durationDays: 1,
            instructions: "Take with food"
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    const reminders = await remindersForAppointment(appointment.id);
    const prescription = await prisma.prescription.findFirstOrThrow({
      where: {
        appointmentId: appointment.id
      }
    });

    assert.equal(reminders.length, 2);
    assert.ok(
      reminders.every((reminder) => reminder.prescriptionId === prescription.id)
    );
    assert.equal(prescription.medicineName, "Authoritative Medicine");
    assert.equal(prescription.dosage, "20mg");
    assert.equal(prescription.instructions, "Take with food");
  });

  test("POST_VISIT_SUMMARY job still exists exactly once", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "Post job notes.",
        followUpInstructions: null,
        prescriptions: [
          {
            medicine: "Post Job Medicine",
            dosage: "20mg",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 1,
            instructions: null
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    const jobs = await postVisitJobsForAppointment(appointment.id);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, OutboxJobStatus.PENDING);
    assert.equal(jobs[0]?.attempts, 0);
  });

  test("AS_NEEDED prescriptions create no scheduled reminders during completion", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "As needed notes.",
        followUpInstructions: null,
        prescriptions: [
          {
            medicine: "As Needed Medicine",
            dosage: "1 tablet",
            frequency: PrescriptionFrequency.AS_NEEDED,
            durationDays: 3,
            instructions: "Take only if needed"
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    assert.equal(await reminderCountForAppointment(appointment.id), 0);
  });
});

describe("medication reminder rollback and idempotency", () => {
  test("forced reminder-generation failure rolls back visit completion", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await assert.rejects(
      () =>
        completeDoctorVisit(
          {
            doctorUserId: doctor.userId,
            appointmentId: appointment.id,
            clinicalNotes: "Rollback reminder notes.",
            followUpInstructions: "Rollback reminder follow-up.",
            prescriptions: [
              {
                medicine: "Rollback Medicine",
                dosage: "10mg",
                frequency: PrescriptionFrequency.THREE_TIMES_DAILY,
                durationDays: 2,
                instructions: "Rollback instructions"
              }
            ]
          },
          {
            now: dateUtc(2035, 1, 1, 8),
            simulateReminderSchedulingFailure: true
          }
        ),
      /Simulated medication reminder scheduling failure/
    );

    const storedAppointment = await prisma.appointment.findUniqueOrThrow({
      where: {
        id: appointment.id
      },
      select: {
        status: true,
        clinicalNotes: true,
        followUpInstructions: true,
        postSummaryStatus: true
      }
    });

    assert.equal(storedAppointment.status, AppointmentStatus.BOOKED);
    assert.equal(storedAppointment.clinicalNotes, null);
    assert.equal(storedAppointment.followUpInstructions, null);
    assert.equal(storedAppointment.postSummaryStatus, AiSummaryStatus.NOT_REQUESTED);
    assert.equal(await prescriptionCountForAppointment(appointment.id), 0);
    assert.equal(await reminderCountForAppointment(appointment.id), 0);
    assert.equal((await postVisitJobsForAppointment(appointment.id)).length, 0);
  });

  test("reminder scheduling helper called twice does not create duplicates", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor, {
      frequency: PrescriptionFrequency.TWICE_DAILY,
      durationDays: 2
    });

    await createMedicationRemindersForPrescriptions(
      prisma,
      [prescription],
      dateUtc(2035, 1, 1, 8)
    );
    await createMedicationRemindersForPrescriptions(
      prisma,
      [prescription],
      dateUtc(2035, 1, 1, 8)
    );

    const reminderCount = await prisma.medicationReminder.count({
      where: {
        prescriptionId: prescription.id
      }
    });

    assert.equal(reminderCount, 4);
  });

  test("repeated completion does not duplicate reminders", async () => {
    const doctor = await createDoctor();
    const appointment = await createAppointment(doctor);

    await completeDoctorVisit(
      {
        doctorUserId: doctor.userId,
        appointmentId: appointment.id,
        clinicalNotes: "First completion notes.",
        followUpInstructions: null,
        prescriptions: [
          {
            medicine: "Repeat Completion Medicine",
            dosage: "10mg",
            frequency: PrescriptionFrequency.ONCE_DAILY,
            durationDays: 2,
            instructions: null
          }
        ]
      },
      {
        now: dateUtc(2035, 1, 1, 8)
      }
    );

    const beforeRetryCount = await reminderCountForAppointment(appointment.id);

    await assert.rejects(
      () =>
        completeDoctorVisit(
          {
            doctorUserId: doctor.userId,
            appointmentId: appointment.id,
            clinicalNotes: "Second completion notes.",
            followUpInstructions: null,
            prescriptions: [
              {
                medicine: "Duplicate Medicine",
                dosage: "10mg",
                frequency: PrescriptionFrequency.ONCE_DAILY,
                durationDays: 2,
                instructions: null
              }
            ]
          },
          {
            now: dateUtc(2035, 1, 1, 8)
          }
        ),
      /Appointment has already been completed/
    );

    assert.equal(beforeRetryCount, 2);
    assert.equal(await reminderCountForAppointment(appointment.id), 2);
    assert.equal(await prescriptionCountForAppointment(appointment.id), 1);
  });

  test("database unique protection rejects duplicate prescription/time reminders", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);
    const scheduledAt = dateUtc(2035, 1, 1, 9);

    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt
      }
    });

    await assert.rejects(
      () =>
        prisma.medicationReminder.create({
          data: {
            prescriptionId: prescription.id,
            scheduledAt
          }
        }),
      (error) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
    );
  });
});

describe("due medication reminder query", () => {
  test("due-reminder service returns only PENDING reminders with scheduledAt <= now", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);
    const now = dateUtc(2030, 1, 1, 9);
    const duePast = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 1, 1, 8)
      }
    });
    const dueAtNow = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: now
      }
    });
    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 1, 1, 10)
      }
    });
    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 1, 1, 7),
        status: MedicationReminderStatus.SENT
      }
    });

    const dueReminders = await findDueMedicationReminders(now);
    const dueIds = dueReminders.map((reminder) => reminder.id);

    assert.ok(dueIds.includes(duePast.id));
    assert.ok(dueIds.includes(dueAtNow.id));
  });

  test("future reminders are excluded from due results", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);
    const now = dateUtc(2030, 2, 1, 9);
    const futureReminder = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 2, 1, 10)
      }
    });

    const dueReminders = await findDueMedicationReminders(now);

    assert.ok(!dueReminders.some((reminder) => reminder.id === futureReminder.id));
  });

  test("SENT and FAILED reminders are excluded from due results", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);
    const now = dateUtc(2030, 3, 1, 9);
    const sentReminder = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 3, 1, 8),
        status: MedicationReminderStatus.SENT
      }
    });
    const failedReminder = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 3, 1, 7),
        status: MedicationReminderStatus.FAILED
      }
    });

    const dueReminders = await findDueMedicationReminders(now);
    const dueIds = dueReminders.map((reminder) => reminder.id);

    assert.ok(!dueIds.includes(sentReminder.id));
    assert.ok(!dueIds.includes(failedReminder.id));
  });

  test("due results are ordered predictably by scheduled time", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);
    const now = dateUtc(2030, 4, 1, 9);
    const later = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 4, 1, 9)
      }
    });
    const earlier = await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 4, 1, 8)
      }
    });

    const dueReminders = await findDueMedicationReminders(now, 100);
    const localDueIds = dueReminders
      .map((reminder) => reminder.id)
      .filter((id) => id === earlier.id || id === later.id);

    assert.deepEqual(localDueIds, [earlier.id, later.id]);
  });

  test("due query limit is respected", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);
    const now = dateUtc(2030, 4, 2, 9);

    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 4, 2, 7)
      }
    });
    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 4, 2, 8)
      }
    });

    const dueReminders = await findDueMedicationReminders(now, 1);

    assert.equal(dueReminders.length, 1);
  });

  test("due reminder service does not expose passwordHash", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);

    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        scheduledAt: dateUtc(2030, 5, 1, 8)
      }
    });

    const dueReminders = await findDueMedicationReminders(dateUtc(2030, 5, 1, 9));

    assert.equal(containsSensitiveField(dueReminders), false);
  });

  test("reminder records contain no secrets", async () => {
    const doctor = await createDoctor();
    const { prescription } = await createPrescription(doctor);

    await createMedicationRemindersForPrescriptions(
      prisma,
      [prescription],
      dateUtc(2035, 1, 1, 8)
    );

    const reminders = await prisma.medicationReminder.findMany({
      where: {
        prescriptionId: prescription.id
      }
    });
    const serialized = JSON.stringify(reminders);

    assert.equal(serialized.includes("JWT_SECRET"), false);
    assert.equal(serialized.includes("LLM_API_KEY"), false);
    assert.equal(serialized.includes("DATABASE_URL"), false);
    assert.equal(serialized.includes("Password123!"), false);
  });
});
