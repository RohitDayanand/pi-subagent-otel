/**
 * A session's own conversation: each user prompt, provider request and tool call, with content.
 * pi events -> conversation events. The parent uses it for its own session; `child.ts` uses it inside
 * each subagent and sends the events over the fleet socket.
 *
 * A provider request starts at `context_with_system`, which fires once before each LLM call in the
 * agent loop with the exact transcript sent, and ends at the assistant `message_end`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConversationEvent } from "../types.ts";

export function subscribeToConversation(pi: ExtensionAPI, send: (event: ConversationEvent) => void): void {
	let callCount = 0;
	let openCallKey: string | undefined;

	pi.on("agent_start", () => send({ kind: "agent.start" }));
	pi.on("agent_end", (event) => send({ kind: "agent.end", messages: event.messages }));

	pi.on("context_with_system", (event, ctx) => {
		callCount++;
		openCallKey = String(callCount);
		send({
			kind: "llm.start",
			callKey: openCallKey,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			messages: event.messages,
		});
		// No return value: the transcript is sent unchanged.
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !openCallKey) return;
		const { stopReason } = message;
		send({
			kind: "llm.end",
			callKey: openCallKey,
			responseModel: message.responseModel ?? message.model,
			responseId: message.responseId,
			output: message,
			usage: message.usage,
			stopReason,
			error:
				stopReason === "error" || stopReason === "aborted"
					? { type: stopReason, message: message.errorMessage }
					: undefined,
		});
		openCallKey = undefined;
	});

	pi.on("tool_execution_start", (event) =>
		send({ kind: "tool.start", toolCallId: event.toolCallId, toolName: event.toolName, arguments: event.args }),
	);
	pi.on("tool_execution_end", (event) =>
		send({ kind: "tool.end", toolCallId: event.toolCallId, result: event.result, isError: event.isError }),
	);
}
