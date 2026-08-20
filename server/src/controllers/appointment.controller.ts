import type { Request, Response } from "express";
import { z } from "zod";

import { AppError } from "../middleware/app-error.js";
import {
  confirmAppointment,
  maxSymptomsLength
} from "../services/appointment-booking.service.js";
import {
  cancelPatientAppointment,
  getPatientAppointment,
  listPatientAppointments,
  reschedulePatientAppointment
} from "../services/patient-appointment.service.js";
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

const rescheduleAppointmentSchema = z
  .object({
    newReservationId: z.string().trim().min(1)
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

export async function listMyAppointments(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const appointments = await listPatientAppointments(req.user.id);

  return res.status(200).json({
    appointments
  });
}

export async function getMyAppointment(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const appointment = await getPatientAppointment(req.user.id, req.params.id);

  return res.status(200).json({
    appointment
  });
}

export async function cancelMyAppointment(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const appointment = await cancelPatientAppointment(req.user.id, req.params.id);

  return res.status(200).json({
    appointment
  });
}

export async function rescheduleMyAppointment(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const input = rescheduleAppointmentSchema.parse(req.body);
  const result = await reschedulePatientAppointment({
    patientId: req.user.id,
    appointmentId: req.params.id,
    newReservationId: input.newReservationId
  });

  return res.status(result.reused ? 200 : 201).json({
    appointment: result.appointment
  });
}
