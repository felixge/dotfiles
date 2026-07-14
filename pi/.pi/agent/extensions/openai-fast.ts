import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-fast";
const SUPPORTED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEligible(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return Boolean(
    model &&
      model.provider === "openai-codex" &&
      model.api === "openai-codex-responses" &&
      SUPPORTED_MODELS.has(model.id) &&
      ctx.modelRegistry.isUsingOAuth(model),
  );
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, enabled && isEligible(ctx) ? "fast" : undefined);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = true;
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !isEligible(ctx) || !isRecord(event.payload)) return;
    if (event.payload.model !== ctx.model?.id || Object.hasOwn(event.payload, "service_tier")) {
      return;
    }

    return { ...event.payload, service_tier: "priority" };
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Codex Fast mode",
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase()) {
        case "":
          enabled = !enabled;
          break;
        case "on":
          enabled = true;
          break;
        case "off":
          enabled = false;
          break;
        case "status":
          break;
        default:
          ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
          return;
      }

      updateStatus(ctx);
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
      const state = enabled ? (isEligible(ctx) ? "on" : "on, but inactive") : "off";
      ctx.ui.notify(`Fast mode is ${state} for ${model}.`, "info");
    },
  });
}
