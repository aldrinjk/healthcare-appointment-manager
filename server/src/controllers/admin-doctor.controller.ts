import type { Request, Response } from "express";
import { Weekday } from "@prisma/client";
import { z } from "zod";

import {
  addAvailability,
  addLeave,
  createDoctor,
  getDoctor,
  listDoctors,
  removeLeave,
  updateDoctor
} from "../services/admin-doctor.service.js";

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must use HH:mm format");

const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/[A-Za-z]/, "Password must include a letter")
  .regex(/[0-9]/, "Password must include a number");

const slotDurationSchema = z.number().int().min(5).max(240);

const paramsSchema = z.object({
  id: z.string().min(1)
});

const leaveParamsSchema = paramsSchema.extend({
  leaveId: z.string().min(1)
});

const createDoctorSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320),
    password: passwordSchema,
    specialization: z.string().trim().min(1).max(120),
    slotDuration: slotDurationSchema
  })
  .strict();

const updateDoctorSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    specialization: z.string().trim().min(1).max(120).optional(),
    slotDuration: slotDurationSchema.optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one update field is required"
  });

const availabilitySchema = z
  .object({
    weekday: z.nativeEnum(Weekday),
    startTime: timeSchema,
    endTime: timeSchema
  })
  .strict()
  .refine((value) => value.startTime < value.endTime, {
    message: "startTime must be before endTime",
    path: ["endTime"]
  });

const leaveSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format"),
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export async function listAdminDoctors(_req: Request, res: Response) {
  const doctors = await listDoctors();

  return res.status(200).json({ doctors });
}

export async function getAdminDoctor(req: Request, res: Response) {
  const { id } = paramsSchema.parse(req.params);
  const doctor = await getDoctor(id);

  return res.status(200).json({ doctor });
}

export async function createAdminDoctor(req: Request, res: Response) {
  const input = createDoctorSchema.parse(req.body);
  const doctor = await createDoctor(input);

  return res.status(201).json({ doctor });
}

export async function updateAdminDoctor(req: Request, res: Response) {
  const { id } = paramsSchema.parse(req.params);
  const input = updateDoctorSchema.parse(req.body);
  const doctor = await updateDoctor(id, input);

  return res.status(200).json({ doctor });
}

export async function createAdminDoctorAvailability(req: Request, res: Response) {
  const { id } = paramsSchema.parse(req.params);
  const input = availabilitySchema.parse(req.body);
  const availability = await addAvailability(id, input);

  return res.status(201).json({ availability });
}

export async function createAdminDoctorLeave(req: Request, res: Response) {
  const { id } = paramsSchema.parse(req.params);
  const input = leaveSchema.parse(req.body);
  const leave = await addLeave(id, input);

  return res.status(201).json({ leave });
}

export async function deleteAdminDoctorLeave(req: Request, res: Response) {
  const { id, leaveId } = leaveParamsSchema.parse(req.params);
  await removeLeave(id, leaveId);

  return res.status(204).send();
}
