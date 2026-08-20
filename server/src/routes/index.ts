import { Router } from "express";

import { env } from "../config/env.js";
import { authRouter } from "./auth.routes.js";
import { healthRouter } from "./health.routes.js";
import { rbacTestRouter } from "./rbac-test.routes.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/health", healthRouter);

if (env.NODE_ENV === "test") {
  apiRouter.use("/test/rbac", rbacTestRouter);
}
