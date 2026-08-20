import { Router } from "express";

import {
  getDoctor,
  listDoctors,
  listDoctorSlots
} from "../controllers/doctor.controller.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const doctorRouter = Router();

doctorRouter.get("/", asyncHandler(listDoctors));
doctorRouter.get("/:id", asyncHandler(getDoctor));
doctorRouter.get("/:id/slots", asyncHandler(listDoctorSlots));
