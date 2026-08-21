export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export class EmailProviderError extends Error {
  constructor(message = "Email provider failed") {
    super(message);
  }
}
