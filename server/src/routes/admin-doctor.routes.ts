import { Router } from "express";
import { UserRole } from "@prisma/client";

import {
  createAdminDoctor,
  createAdminDoctorAvailability,
  createAdminDoctorLeave,
  deleteAdminDoctorLeave,
  getAdminDoctor,
  listAdminDoctors,
  updateAdminDoctor
} from "../controllers/admin-doctor.controller.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireRole } from "../middleware/require-role.js";

export const adminDoctorRouter = Router();

adminDoctorRouter.use(authenticate, requireRole(UserRole.ADMIN));

adminDoctorRouter.get("/", asyncHandler(listAdminDoctors));
adminDoctorRouter.post("/", asyncHandler(createAdminDoctor));
adminDoctorRouter.get("/:id", asyncHandler(getAdminDoctor));
adminDoctorRouter.patch("/:id", asyncHandler(updateAdminDoctor));
adminDoctorRouter.post(
  "/:id/availability",
  asyncHandler(createAdminDoctorAvailability)
);
adminDoctorRouter.post("/:id/leave", asyncHandler(createAdminDoctorLeave));
adminDoctorRouter.delete(
  "/:id/leave/:leaveId",
  asyncHandler(deleteAdminDoctorLeave)
);
