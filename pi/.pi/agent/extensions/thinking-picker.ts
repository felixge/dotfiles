import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+t", {
    description: "Choose thinking level",
    handler: async (ctx) => {
      if (!ctx.model?.reasoning) {
        ctx.ui.notify("Current model does not support thinking", "warning");
        return;
      }

      const levels = getSupportedThinkingLevels(ctx.model);
      const current = pi.getThinkingLevel();
      const items: SelectItem[] = levels.map((level) => ({
        value: level,
        label: level === current ? `${level} (current)` : level,
      }));

      const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Thinking level")), 1, 0));

        const selectList = new SelectList(items, items.length, {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        selectList.setSelectedIndex(Math.max(0, levels.indexOf(current)));
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (selected) {
        pi.setThinkingLevel(selected);
      }
    },
  });
}
