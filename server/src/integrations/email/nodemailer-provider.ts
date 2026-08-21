import nodemailer from "nodemailer";

import { env } from "../../config/env.js";
import { AppError } from "../../middleware/app-error.js";
import type { EmailMessage, EmailProvider } from "./email-provider.js";

export class NodemailerProvider implements EmailProvider {
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor() {
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.SMTP_FROM) {
      throw new AppError(
        "SMTP email provider requires SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM",
        500,
        "EMAIL_PROVIDER_NOT_CONFIGURED"
      );
    }

    this.from = env.SMTP_FROM;
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS
      }
    });
  }

  async send(message: EmailMessage) {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  }
}
