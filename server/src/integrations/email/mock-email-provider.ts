import type { EmailMessage, EmailProvider } from "./email-provider.js";

export class MockEmailProvider implements EmailProvider {
  readonly deliveries: EmailMessage[] = [];
  failNextDelivery = false;
  failAllDeliveries = false;

  constructor(
    private readonly options: {
      failAllDeliveries?: boolean;
    } = {}
  ) {
    this.failAllDeliveries = options.failAllDeliveries ?? false;
  }

  async send(message: EmailMessage) {
    if (this.failAllDeliveries || this.failNextDelivery) {
      this.failNextDelivery = false;
      throw new Error("Mock email provider failure with smtp://secret.example");
    }

    this.deliveries.push({ ...message });
  }

  failOnce() {
    this.failNextDelivery = true;
  }

  reset() {
    this.deliveries.length = 0;
    this.failNextDelivery = false;
    this.failAllDeliveries = this.options.failAllDeliveries ?? false;
  }
}
