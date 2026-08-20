import { Router } from "express";

import { env } from "../config/env.js";
import { adminDoctorRouter } from "./admin-doctor.routes.js";
import { appointmentRouter } from "./appointment.routes.js";
import { authRouter } from "./auth.routes.js";
import { doctorAppointmentRouter } from "./doctor-appointment.routes.js";
import { doctorRouter } from "./doctor.routes.js";
import { healthRouter } from "./health.routes.js";
import { rbacTestRouter } from "./rbac-test.routes.js";

export const apiRouter = Router();

apiRouter.use("/admin/doctors", adminDoctorRouter);
apiRouter.use("/appointments", appointmentRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/doctor/appointments", doctorAppointmentRouter);
apiRouter.use("/doctors", doctorRouter);
apiRouter.use("/health", healthRouter);

if (env.NODE_ENV === "test") {
  apiRouter.use("/test/rbac", rbacTestRouter);
}
