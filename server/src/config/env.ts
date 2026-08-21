import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  LLM_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().optional().default("gpt-4o-mini"),
  EMAIL_PROVIDER: z.enum(["mock", "smtp"]).default("mock"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().optional().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z
    .string()
    .optional()
    .default("Healthcare App <no-reply@example.com>")
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.flatten().fieldErrors;

  throw new Error(
    `Invalid environment configuration: ${JSON.stringify(details)}`
  );
}

export const env = parsedEnv.data;
