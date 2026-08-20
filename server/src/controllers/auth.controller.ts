import type { Request, Response } from "express";
import { z } from "zod";

import {
  getUserById,
  login,
  registerPatient
} from "../services/auth.service.js";
import { AppError } from "../middleware/app-error.js";

const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/[A-Za-z]/, "Password must include a letter")
  .regex(/[0-9]/, "Password must include a number");

const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320),
    password: passwordSchema
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(128)
  })
  .strict();

export async function register(req: Request, res: Response) {
  const input = registerSchema.parse(req.body);
  const user = await registerPatient(input);

  return res.status(201).json({ user });
}

export async function loginUser(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const result = await login(input);

  return res.status(200).json(result);
}

export async function me(req: Request, res: Response) {
  if (!req.user) {
    throw new AppError("Authentication token is required", 401, "UNAUTHORIZED");
  }

  const user = await getUserById(req.user.id);

  return res.status(200).json({ user });
}
