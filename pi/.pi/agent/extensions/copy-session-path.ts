import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+s", {
    description: "Copy current session file path",
    handler: async (ctx) => {
      const path = ctx.sessionManager.getSessionFile();
      if (!path) {
        ctx.ui.notify("This session has no file to copy", "warning");
        return;
      }

      try {
        await copyToClipboard(path);
        ctx.ui.notify(`Copied session path: ${path}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not copy session path: ${String(error)}`, "error");
      }
    },
  });
}
