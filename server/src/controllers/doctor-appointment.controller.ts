import { PrescriptionFrequency } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";

import { AppError } from "../middleware/app-error.js";
import {
  completeDoctorVisit,
  getDoctorAppointment,
  listDoctorAppointments,
  maxClinicalNotesLength,
  maxFollowUpInstructionsLength,
  maxPrescriptionItems
} from "../services/doctor-appointment.service.js";

const idParamsSchema = z.object({
  id: z.string().min(1)
});

const completeVisitSchema = z
  .object({
    clinicalNotes: z.string().trim().min(1).max(maxClinicalNotesLength),
    followUpInstructions: z
      .string()
      .trim()
      .max(maxFollowUpInstructionsLength)
      .optional()
      .nullable(),
    prescriptions: z
      .array(
        z
          .object({
            medicine: z.string().trim().min(1).max(200),
            dosage: z.string().trim().min(1).max(200),
            frequency: z.nativeEnum(PrescriptionFrequency),
            durationDays: z.number().int().positive().max(365),
            instructions: z.string().trim().max(1_000).optional().nullable()
          })
          .strict()
      )
      .min(1)
      .max(maxPrescriptionItems)
  })
  .strict();

export async function listMyDoctorAppointments(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const appointments = await listDoctorAppointments(req.user.id);

  return res.status(200).json({ appointments });
}

export async function getMyDoctorAppointment(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const { id } = idParamsSchema.parse(req.params);
  const appointment = await getDoctorAppointment(req.user.id, id);

  return res.status(200).json({ appointment });
}

export async function completeMyDoctorAppointment(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const { id } = idParamsSchema.parse(req.params);
  const input = completeVisitSchema.parse(req.body);
  const appointment = await completeDoctorVisit({
    doctorUserId: req.user.id,
    appointmentId: id,
    clinicalNotes: input.clinicalNotes,
    followUpInstructions: input.followUpInstructions,
    prescriptions: input.prescriptions
  });

  return res.status(200).json({ appointment });
}
