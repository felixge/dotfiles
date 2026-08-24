const mode = process.argv[2] ?? "success";

if (mode === "hang") {
	setInterval(() => {}, 1_000);
} else {
	if (mode === "malformed") process.stdout.write("not-json\n");
	if (mode === "stderr") process.stderr.write("e".repeat(10_000));
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
				content: [{ type: "text", text: "fixture result" }],
				usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
				stopReason: "stop"
			}
		},
		{ type: "agent_settled" }
	];
	for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}
