import type { Request, Response } from "express";
import { z } from "zod";

import {
  getAvailableSlots,
  getPublicDoctor,
  listPublicDoctors
} from "../services/doctor.service.js";

const idParamsSchema = z.object({
  id: z.string().min(1)
});

const listDoctorsQuerySchema = z.object({
  specialization: z.string().trim().min(1).max(120).optional()
});

const slotsQuerySchema = z.object({
  date: z.string().min(1)
});

export async function listDoctors(req: Request, res: Response) {
  const query = listDoctorsQuerySchema.parse(req.query);
  const doctors = await listPublicDoctors(query.specialization);

  return res.status(200).json({ doctors });
}

export async function getDoctor(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const doctor = await getPublicDoctor(id);

  return res.status(200).json({ doctor });
}

export async function listDoctorSlots(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const { date } = slotsQuerySchema.parse(req.query);
  const result = await getAvailableSlots(id, date);

  return res.status(200).json(result);
}
