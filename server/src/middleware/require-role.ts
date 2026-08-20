import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";

import { AppError } from "./app-error.js";

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new AppError("Authentication token is required", 401, "UNAUTHORIZED"));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(new AppError("Insufficient permissions", 403, "FORBIDDEN"));
      return;
    }

    next();
  };
}
