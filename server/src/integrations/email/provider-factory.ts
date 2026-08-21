import { env } from "../../config/env.js";
import { MockEmailProvider } from "./mock-email-provider.js";
import { NodemailerProvider } from "./nodemailer-provider.js";
import type { EmailProvider } from "./email-provider.js";

export function createEmailProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER === "smtp") {
    return new NodemailerProvider();
  }

  return new MockEmailProvider();
}
