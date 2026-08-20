import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Prisma, UserRole, type User } from "@prisma/client";

import { env } from "../config/env.js";
import type { AuthenticatedUser, SafeUser } from "../types/auth.js";
import { prisma } from "../utils/prisma.js";
import { AppError } from "../middleware/app-error.js";

const passwordSaltRounds = 12;
const tokenExpiry = "1h";

export type RegisterInput = {
  name: string;
  email: string;
  password: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function toSafeUser(user: Pick<User, "id" | "name" | "email" | "role">): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function signToken(user: AuthenticatedUser) {
  return jwt.sign(
    {
      email: user.email,
      role: user.role
    },
    env.JWT_SECRET,
    {
      subject: user.id,
      expiresIn: tokenExpiry
    }
  );
}

export async function registerPatient(input: RegisterInput) {
  const email = normalizeEmail(input.email);
  const passwordHash = await bcrypt.hash(input.password, passwordSaltRounds);

  try {
    const user = await prisma.user.create({
      data: {
        name: input.name.trim(),
        email,
        passwordHash,
        role: UserRole.PATIENT
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true
      }
    });

    return toSafeUser(user);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError("Email is already registered", 409, "EMAIL_ALREADY_REGISTERED");
    }

    throw error;
  }
}

export async function login(input: LoginInput) {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) {
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);

  if (!passwordMatches) {
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }

  const safeUser = toSafeUser(user);

  return {
    token: signToken(safeUser),
    user: safeUser
  };
}

export async function getUserById(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true
    }
  });

  if (!user) {
    throw new AppError("Authenticated user was not found", 401, "UNAUTHORIZED");
  }

  return toSafeUser(user);
}
