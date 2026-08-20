import type { Request, Response } from "express";
import { z } from "zod";

import { AppError } from "../middleware/app-error.js";
import { holdSlot } from "../services/slot-reservation.service.js";

const holdSchema = z
  .object({
    doctorId: z.string().min(1),
    startAt: z.string().datetime({ offset: true })
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
