import { UserRole } from "@prisma/client";
import { Router } from "express";

import {
  completeMyDoctorAppointment,
  getMyDoctorAppointment,
  listMyDoctorAppointments
} from "../controllers/doctor-appointment.controller.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireRole } from "../middleware/require-role.js";

export const doctorAppointmentRouter = Router();

doctorAppointmentRouter.use(authenticate, requireRole(UserRole.DOCTOR));

doctorAppointmentRouter.get("/", asyncHandler(listMyDoctorAppointments));
doctorAppointmentRouter.get("/:id", asyncHandler(getMyDoctorAppointment));
doctorAppointmentRouter.post(
  "/:id/complete",
  asyncHandler(completeMyDoctorAppointment)
);
