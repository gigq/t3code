import { Effect, Layer, Schema } from "effect";

import {
  TextGenerationError,
  type ChatAttachment,
  type OpenCodeModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import {
  createOpenCodeSdkClient,
  parseOpenCodeModelSlug,
  startOpenCodeServerProcess,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";

const makeOpenCodeTextGeneration = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: OpenCodeModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((value) => value.providers.opencode),
      Effect.orElseSucceed(() => ({ enabled: true, binaryPath: "opencode", customModels: [] })),
    );

    const fileParts = toOpenCodeFileParts({
      attachments: input.attachments,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const structuredOutput = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => startOpenCodeServerProcess({ binaryPath: settings.binaryPath }),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: cause instanceof Error ? cause.message : "Failed to start OpenCode server.",
            cause,
          }),
      }),
      (server) =>
        Effect.tryPromise({
          try: async () => {
            const client = createOpenCodeSdkClient({ baseUrl: server.url, directory: input.cwd });
            const session = await client.session.create({
              title: `T3 Code ${input.operation}`,
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            });
            if (!session.data) {
              throw new Error("OpenCode session.create returned no session payload.");
            }

            const result = await client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(input.modelSelection.options?.agent
                ? { agent: input.modelSelection.options.agent }
                : {}),
              ...(input.modelSelection.options?.variant
                ? { variant: input.modelSelection.options.variant }
                : {}),
              format: {
                type: "json_schema",
                schema: toJsonSchemaObject(input.outputSchemaJson) as Record<string, unknown>,
              },
              parts: [{ type: "text", text: input.prompt }, ...fileParts],
            });
            const structured = result.data?.info.structured;
            if (structured === undefined) {
              throw new Error("OpenCode returned no structured output.");
            }
            return structured;
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail:
                cause instanceof Error ? cause.message : "OpenCode text generation request failed.",
              cause,
            }),
        }),
      (server) => Effect.sync(() => server.close()),
    );

    return yield* Schema.decodeUnknownEffect(input.outputSchemaJson)(structuredOutput).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OpenCodeTextGeneration.generatePrContent",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpenCodeTextGeneration.generateBranchName",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const OpenCodeTextGenerationLive = Layer.effect(TextGeneration, makeOpenCodeTextGeneration);
