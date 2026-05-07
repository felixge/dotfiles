import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROCESS_TITLE = "π";
const OSC_TITLE = `\x1b]0;${PROCESS_TITLE}\x07\x1b]2;${PROCESS_TITLE}\x07`;
const TMUX_OSC_TITLE = `\x1bPtmux;\x1b${OSC_TITLE.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;

function setProcessTitle(): void {
	// Node's process.title changes the argv/title string visible to tools such
	// as `ps -o args`, but on macOS it does not change the kernel's `comm` name.
	// When pi is launched through Volta's shebang shim, terminals such as kitty
	// may therefore still identify the foreground process as `volta-shim`.
	process.title = PROCESS_TITLE;
}

function setTerminalTitle(): void {
	// Explicit OSC title sequences are what terminal emulators use for the tab /
	// window title. Wrap for tmux so it passes the OSC through to the outer
	// terminal instead of swallowing it.
	const titleSequence = process.env.TMUX ? TMUX_OSC_TITLE : OSC_TITLE;
	process.stdout.write(titleSequence);
}

function setTmuxTitle(): void {
	if (!process.env.TMUX) return;
	try {
		// tmux has its own ideas about titles. Set the pane title (used by
		// #{pane_title}), the window name (used by #W), and disable automatic
		// window renaming so tmux doesn't switch it back to `volta-shim` from
		// #{pane_current_command}.
		execFileSync("tmux", ["select-pane", "-T", PROCESS_TITLE], { stdio: "ignore" });
		execFileSync("tmux", ["rename-window", PROCESS_TITLE], { stdio: "ignore" });
		execFileSync("tmux", ["set-option", "-w", "automatic-rename", "off"], { stdio: "ignore" });
	} catch {
		// Ignore: pi may be running under a tmux-like environment without the tmux
		// client available, or with a stale TMUX variable.
	}
}

function applyTitle(): void {
	setProcessTitle();
	setTmuxTitle();
	if (process.stdout.isTTY) setTerminalTitle();
}

function psDebug(): string {
	try {
		return execFileSync("ps", ["-p", String(process.pid), "-o", "pid=,comm=,args="], {
			encoding: "utf8",
		}).trim();
	} catch (err) {
		return `ps failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

function tmuxDebug(format: string): string {
	if (!process.env.TMUX) return "not-in-tmux";
	try {
		return execFileSync("tmux", ["display-message", "-p", format], { encoding: "utf8" }).trim();
	} catch (err) {
		return `tmux failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

export default function (pi: ExtensionAPI) {
	// Set it as early as possible during extension loading, then re-apply after
	// lifecycle transitions/reloads in case another component changes it.
	applyTitle();

	let interval: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async () => {
		applyTitle();
		interval ??= setInterval(applyTitle, 5000);
		interval.unref?.();
	});

	pi.on("resources_discover", async () => {
		applyTitle();
	});

	pi.on("session_shutdown", async () => {
		if (interval) clearInterval(interval);
		interval = undefined;
	});

	pi.registerCommand("set-process-title", {
		description: "Set this process and terminal title to pi",
		handler: async (_args, ctx) => {
			applyTitle();
			ctx.ui.notify(`Process/terminal title set to ${PROCESS_TITLE}`, "info");
		},
	});

	pi.registerCommand("process-title-debug", {
		description: "Show process-title debugging information",
		handler: async (_args, ctx) => {
			applyTitle();
			ctx.ui.notify(
				[
					`process.title=${process.title}`,
					`argv0=${process.argv0}`,
					`execPath=${process.execPath}`,
					`TMUX=${process.env.TMUX ? "yes" : "no"}`,
					`tmuxWindow=${tmuxDebug("#{window_name}")}`,
					`tmuxPaneTitle=${tmuxDebug("#{pane_title}")}`,
					`tmuxPaneCommand=${tmuxDebug("#{pane_current_command}")}`,
					`ps=${psDebug()}`,
				].join("\n"),
				"info",
			);
		},
	});
}
