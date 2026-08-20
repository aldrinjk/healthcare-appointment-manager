import type { Request, Response } from "express";
import { z } from "zod";

import { AppError } from "../middleware/app-error.js";
import {
  confirmAppointment,
  maxSymptomsLength
} from "../services/appointment-booking.service.js";
import { holdSlot } from "../services/slot-reservation.service.js";

const holdSchema = z
  .object({
    doctorId: z.string().min(1),
    startAt: z.string().datetime({ offset: true })
  })
  .strict();

const confirmAppointmentSchema = z
  .object({
    reservationId: z.string().trim().min(1),
    symptoms: z.string().trim().min(1).max(maxSymptomsLength)
  })
  .strict();

export async function createSlotHold(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const input = holdSchema.parse(req.body);
  const result = await holdSlot({
    patientId: req.user.id,
    doctorId: input.doctorId,
    startAt: input.startAt
  });

  return res.status(result.reused ? 200 : 201).json({
    reservation: result.reservation
  });
}

export async function createAppointment(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const input = confirmAppointmentSchema.parse(req.body);
  const result = await confirmAppointment({
    patientId: req.user.id,
    reservationId: input.reservationId,
    symptoms: input.symptoms
  });

  return res.status(result.reused ? 200 : 201).json({
    appointment: result.appointment
  });
}
