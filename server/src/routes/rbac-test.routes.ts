import { Router } from "express";
import { UserRole } from "@prisma/client";

import { authenticate } from "../middleware/authenticate.js";
import { requireRole } from "../middleware/require-role.js";

export const rbacTestRouter = Router();

rbacTestRouter.get("/protected", authenticate, (_req, res) => {
  res.status(200).json({ status: "ok" });
});

rbacTestRouter.get(
  "/admin",
  authenticate,
  requireRole(UserRole.ADMIN),
  (_req, res) => {
    res.status(200).json({ status: "ok" });
  }
);

rbacTestRouter.get(
  "/doctor",
  authenticate,
  requireRole(UserRole.DOCTOR),
  (_req, res) => {
    res.status(200).json({ status: "ok" });
  }
);
