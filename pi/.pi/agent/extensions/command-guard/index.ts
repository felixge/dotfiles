import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { CommandGuard } from "./guard.js";

export default function commandGuardExtension(pi: ExtensionAPI) {
  const guard = new CommandGuard();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    let blocked = false;
    const result = await guard.handle(event.input.command, {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      abort: () => {
        blocked = true;
        ctx.abort();
      },
      choose: ctx.hasUI
        ? async (title, options) => {
            try {
              pi.events.emit("herdr:blocked", { active: true, label: "Command guard confirmation" });
              return await ctx.ui.select(title, options);
            } finally {
              pi.events.emit("herdr:blocked", { active: false });
            }
          }
        : undefined,
    });

    if (result && !blocked && ctx.hasUI) ctx.abort();
    return result;
  });
}
