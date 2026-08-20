import { env } from "../../config/env.js";
import { AppError } from "../../middleware/app-error.js";
import { LlmProviderError, type LlmProvider } from "./llm-provider.js";
import { buildPreVisitSummaryPrompt } from "./prompts.js";

type OpenAiProviderOptions = {
  apiKey?: string;
  model?: string;
};

type OpenAiResponsesBody = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
};

function extractOutputText(body: OpenAiResponsesBody) {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  return body.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .find((text): text is string => typeof text === "string");
}

export class OpenAiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: OpenAiProviderOptions = {}) {
    this.apiKey = options.apiKey ?? env.LLM_API_KEY;
    this.model = options.model ?? env.LLM_MODEL;

    if (!this.apiKey) {
      throw new AppError(
        "OpenAI provider requires LLM_API_KEY",
        500,
        "LLM_PROVIDER_NOT_CONFIGURED"
      );
    }
  }

  async generatePreVisitSummary(input: { symptoms: string }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: buildPreVisitSummaryPrompt(input.symptoms),
        text: {
          format: {
            type: "json_schema",
            name: "pre_visit_summary",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["urgency", "chiefComplaint", "suggestedQuestions"],
              properties: {
                urgency: {
                  type: "string",
                  enum: ["LOW", "MEDIUM", "HIGH"]
                },
                chiefComplaint: {
                  type: "string"
                },
                suggestedQuestions: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  items: {
                    type: "string"
                  }
                }
              }
            }
          }
        }
      })
    });

    if (!response.ok) {
      throw new LlmProviderError("OpenAI pre-visit summary request failed");
    }

    const body = (await response.json()) as OpenAiResponsesBody;
    const outputText = extractOutputText(body);

    if (!outputText) {
      throw new LlmProviderError("OpenAI response did not include structured output");
    }

    try {
      return JSON.parse(outputText) as unknown;
    } catch {
      throw new LlmProviderError("OpenAI response was not valid JSON");
    }
  }
}
