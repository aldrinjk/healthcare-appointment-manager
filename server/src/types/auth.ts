import type { UserRole } from "@prisma/client";

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: UserRole;
};

export type SafeUser = AuthenticatedUser & {
  name: string;
};
