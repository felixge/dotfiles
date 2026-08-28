import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const mode = process.argv[2] ?? "success";
let pending = "";
const decoder = new StringDecoder("utf8");
let promptMessage = "";
let finished = false;

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finalEvents() {
	if (finished) return;
	finished = true;
	if (mode === "malformed") process.stdout.write("not-json\n");
	if (mode === "stderr") process.stderr.write("e".repeat(10_000));
	const finalOutput = mode === "large"
		? Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n")
		: mode === "stdin"
			? JSON.stringify({
				bytes: Buffer.byteLength(promptMessage, "utf8"),
				sha256: createHash("sha256").update(promptMessage).digest("hex"),
			})
			: "fixture result";
	const events = [
		{ type: "agent_start" },
		{ type: "turn_start", turnIndex: 0 },
		{
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "secret reasoning" },
		},
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/auth.ts", offset: 1, limit: 20 } },
		{ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: finalOutput }],
				usage: {
					input: 10,
					output: 3,
					cacheRead: 2,
					cacheWrite: 1,
					totalTokens: 16,
					cost: { input: 0.002, output: 0.006, cacheRead: 0.001, cacheWrite: 0.001, total: 0.01 },
				},
				stopReason: "stop",
			},
		},
		{ type: "agent_settled" },
	];
	for (const event of events) write(event);
}

function handleLine(line) {
	if (!line.trim()) return;
	let command;
	try {
		command = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
	} catch (error) {
		write({ type: "response", command: "parse", success: false, error: error.message });
		return;
	}
	if (command.type === "prompt") {
		promptMessage = command.message;
		write({ id: command.id, type: "response", command: "prompt", success: true });
		if (mode !== "hang" && mode !== "steer") finalEvents();
		else if (mode === "steer") write({ type: "agent_start" });
		return;
	}
	if (command.type === "steer") {
		if (command.message === "reject") {
			write({ id: command.id, type: "response", command: "steer", success: false, error: "fixture rejected steering" });
		} else {
			write({ id: command.id, type: "response", command: "steer", success: true });
			if (mode === "steer" && command.message === "finish") finalEvents();
		}
		return;
	}
	write({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported fixture command" });
}

for await (const chunk of process.stdin) {
	pending += decoder.write(chunk);
	while (true) {
		const newline = pending.indexOf("\n");
		if (newline < 0) break;
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		handleLine(line);
	}
}
pending += decoder.end();
if (pending) handleLine(pending);
