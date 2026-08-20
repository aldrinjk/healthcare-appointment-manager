import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { UserRole } from "@prisma/client";

import { env } from "../config/env.js";
import { prisma } from "../utils/prisma.js";
import { AppError } from "./app-error.js";

type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
};

function isJwtPayload(payload: unknown): payload is JwtPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Partial<JwtPayload>;

  return (
    typeof candidate.sub === "string" &&
    typeof candidate.email === "string" &&
    Object.values(UserRole).includes(candidate.role as UserRole)
  );
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const authorization = req.header("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    next(new AppError("Authentication token is required", 401, "UNAUTHORIZED"));
    return;
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    next(new AppError("Authentication token is required", 401, "UNAUTHORIZED"));
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);

    if (!isJwtPayload(payload)) {
      next(new AppError("Invalid authentication token", 401, "UNAUTHORIZED"));
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true
      }
    });

    if (!user) {
      next(new AppError("Invalid authentication token", 401, "UNAUTHORIZED"));
      return;
    }

    req.user = user;
    next();
  } catch {
    next(new AppError("Invalid authentication token", 401, "UNAUTHORIZED"));
  }
}
