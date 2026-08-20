import { Router } from "express";
import { UserRole } from "@prisma/client";

import { createSlotHold } from "../controllers/appointment.controller.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireRole } from "../middleware/require-role.js";

export const appointmentRouter = Router();

appointmentRouter.post(
  "/hold",
  authenticate,
  requireRole(UserRole.PATIENT),
  asyncHandler(createSlotHold)
);
