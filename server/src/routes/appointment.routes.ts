import { Router } from "express";
import { UserRole } from "@prisma/client";

import {
  cancelMyAppointment,
  createAppointment,
  createSlotHold,
  getMyAppointment,
  listMyAppointments,
  rescheduleMyAppointment
} from "../controllers/appointment.controller.js";
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

appointmentRouter.post(
  "/",
  authenticate,
  requireRole(UserRole.PATIENT),
  asyncHandler(createAppointment)
);

appointmentRouter.get(
  "/me",
  authenticate,
  requireRole(UserRole.PATIENT),
  asyncHandler(listMyAppointments)
);

appointmentRouter.get(
  "/:id",
  authenticate,
  requireRole(UserRole.PATIENT),
  asyncHandler(getMyAppointment)
);

appointmentRouter.delete(
  "/:id",
  authenticate,
  requireRole(UserRole.PATIENT),
  asyncHandler(cancelMyAppointment)
);

appointmentRouter.patch(
  "/:id/reschedule",
  authenticate,
  requireRole(UserRole.PATIENT),
  asyncHandler(rescheduleMyAppointment)
);
