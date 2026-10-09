/**
 * Turns source events into spans, following the OTel GenAI conventions:
 *   - one user prompt      -> `invoke_agent pi`
 *   - one provider request -> `chat {model}`
 *   - one tool call        -> `execute_tool {tool}`
 *   - one subagent run     -> `invoke_agent {agent}`
 *   - parallel / chain     -> `invoke_workflow subagent.{mode}` with one `invoke_agent` child per agent
 *   - failures             -> status ERROR + low-cardinality `error.type`
 * Everything hangs under one `pi.session` root. Content is recorded in full as the GenAI content
 * attributes, JSON-encoded because span attributes cannot hold objects. Subagent ids are transient,
 * so they go to `pi.subagent.id`, not `gen_ai.agent.id`.
 */

import * as path from "node:path";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import { isRecord, num, str } from "./parse.ts";
import type {
	ConversationEvent,
	ConversationScope,
	Instrumentation,
	RunInfo,
	RunOutcome,
	SpanEnd,
	Tracer,
	UnknownRecord,
} from "./types.ts";

export const ROOT_SPAN_NAME = "pi.session";

/**
 * Content attributes. Written to the trace file and external telemetry, but not kept in memory once a
 * span ends (see `TracerOptions.retainAttribute`).
 */
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
	"gen_ai.system_instructions",
	"gen_ai.tool.definitions",
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.call.result",
	"pi.subagent.message",
]);

const ROOT_KEY = "root";

type ChildScope = Extract<ConversationScope, { kind: "child" }>;

const childScopeKey = (scope: ChildScope) => `child:${scope.sessionId}`;

/** Spans from a child's conversation carry the process that produced them. */
const processAttributes = (scope: ChildScope): SpanAttributes => ({ "process.pid": scope.pid });

// ---------------------------------------------------------------------------
// Content: pi messages -> GenAI messages ({ role, parts })
// ---------------------------------------------------------------------------

type GenAiPart = Record<string, unknown>;

function contentParts(content: unknown): GenAiPart[] {
	if (typeof content === "string") return [{ type: "text", content }];
	if (!Array.isArray(content))
		return content === undefined ? [] : [{ type: "text", content: JSON.stringify(content) }];
	return content.map((block): GenAiPart => {
		if (!isRecord(block)) return { type: "text", content: String(block) };
		switch (block.type) {
			case "text":
				return { type: "text", content: block.text };
			case "thinking":
				return { type: "reasoning", content: block.thinking };
			case "toolCall":
				return { type: "tool_call", id: block.id, name: block.name, arguments: block.arguments };
			case "image":
				return { type: "blob", modality: "image", mime_type: block.mimeType, content: block.data };
			default:
				return { type: String(block.type), content: block };
		}
	});
}

function genAiMessage(message: unknown): { role: string; parts: GenAiPart[] } {
	if (!isRecord(message)) return { role: "user", parts: contentParts(message) };
	switch (message.role) {
		case "user":
		case "assistant":
		case "system":
			return { role: message.role, parts: contentParts(message.content) };
		case "toolResult":
			return {
				role: "tool",
				parts: [{ type: "tool_call_response", id: message.toolCallId, response: contentParts(message.content) }],
			};
		default:
			// pi custom messages (bashExecution, custom, branchSummary, compactionSummary) reach the model as user text.
			return { role: "user", parts: [{ type: `pi.${String(message.role)}`, content: message }] };
	}
}

const isSystem = (message: unknown) => isRecord(message) && message.role === "system";
const isAssistant = (message: unknown) => isRecord(message) && message.role === "assistant";

/** Splits a transcript into system instructions, tool definitions and input messages. */
function chatInputAttributes(messages: unknown): SpanAttributes {
	const list: unknown[] = Array.isArray(messages) ? messages : [];
	const system = list.filter(isSystem).filter(isRecord);
	const instructions = system.flatMap((message) => [
		...contentParts(message.content),
		...Object.values(isRecord(message.sections) ? message.sections : {})
			.filter((section) => typeof section === "string")
			.map((section): GenAiPart => ({ type: "text", content: section })),
	]);
	const tools = system.flatMap((message) => (Array.isArray(message.toolsAdded) ? message.toolsAdded : []));
	return {
		"gen_ai.system_instructions": instructions.length > 0 ? JSON.stringify(instructions) : undefined,
		"gen_ai.tool.definitions": tools.length > 0 ? JSON.stringify(tools) : undefined,
		"gen_ai.input.messages": JSON.stringify(list.filter((message) => !isSystem(message)).map(genAiMessage)),
	};
}

function outputMessages(message: unknown, finishReason: string | undefined): string {
	return JSON.stringify([{ ...genAiMessage(message), finish_reason: finishReason }]);
}

const textMessages = (role: string, text: string | undefined) =>
	text === undefined ? undefined : JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);

// ---------------------------------------------------------------------------
// Runs: usage and per-agent results
// ---------------------------------------------------------------------------

/**
 * Map a pi `Usage`-shaped object (input, output, cacheRead, cacheWrite, cost) to gen_ai.usage.*.
 * OTel's input_tokens includes cached tokens, while pi's `input` excludes them.
 */
function usageAttributes(usage: unknown): SpanAttributes {
	if (!isRecord(usage)) return {};
	const input = num(usage.input);
	const cacheRead = num(usage.cacheRead);
	const cacheWrite = num(usage.cacheWrite);
	const cost = isRecord(usage.cost) ? num(usage.cost.total) : num(usage.cost);
	return {
		"gen_ai.usage.input_tokens":
			input === undefined && cacheRead === undefined && cacheWrite === undefined
				? undefined
				: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
		"gen_ai.usage.output_tokens": num(usage.output),
		"gen_ai.usage.cache_read.input_tokens": cacheRead,
		"gen_ai.usage.cache_write.input_tokens": cacheWrite,
		"pi.usage.cost_usd": cost,
	};
}

function spanEnd(outcome: RunOutcome): SpanEnd {
	return {
		attributes: {
			...usageAttributes(outcome.usage),
			"gen_ai.output.messages": textMessages("assistant", outcome.output),
			...outcome.attributes,
		},
		error: outcome.error,
	};
}

/** Outcome of one per-agent result row, as reported by the `subagent` tool and pi-subagents. */
function resultOutcome(result: UnknownRecord): RunOutcome {
	const exitCode = num(result.exitCode);
	const stopReason = str(result.stopReason);
	const flagType =
		result.timedOut === true
			? "timeout"
			: result.stopped === true
				? "stopped"
				: result.interrupted === true
					? "interrupted"
					: undefined;
	const failed =
		result.success === false ||
		flagType !== undefined ||
		(exitCode !== undefined && exitCode !== 0) ||
		stopReason === "error" ||
		stopReason === "aborted";
	const errorType =
		flagType ??
		(stopReason === "error" || stopReason === "aborted"
			? stopReason
			: exitCode !== undefined && exitCode !== 0
				? "nonzero_exit"
				: "_OTHER");
	return {
		usage: result.usage,
		output: str(result.output) ?? str(result.summary),
		attributes: {
			"gen_ai.request.model": str(result.model),
			"gen_ai.response.finish_reasons": stopReason ? [stopReason] : undefined,
			"pi.subagent.turns": isRecord(result.usage) ? num(result.usage.turns) : undefined,
			"pi.subagent.exit_code": exitCode,
			"pi.subagent.step": num(result.step),
		},
		error: failed ? { type: errorType, message: str(result.errorMessage) ?? str(result.error) } : undefined,
	};
}

function sumUsage(results: UnknownRecord[]) {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const result of results) {
		if (!isRecord(result.usage)) continue;
		totals.input += num(result.usage.input) ?? 0;
		totals.output += num(result.usage.output) ?? 0;
		totals.cacheRead += num(result.usage.cacheRead) ?? 0;
		totals.cacheWrite += num(result.usage.cacheWrite) ?? 0;
		totals.cost += num(result.usage.cost) ?? 0;
	}
	return totals;
}

function agentSpan(agent: string | undefined, description?: string): { name: string; attributes: SpanAttributes } {
	return {
		name: agent ? `invoke_agent ${agent}` : "invoke_agent",
		attributes: {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": agent,
			"gen_ai.agent.description": description,
		},
	};
}

export function createInstrumentation(
	tracer: Tracer,
	now: () => number,
	conversationId: () => string | undefined,
): Instrumentation {
	let dropped = 0;
	let promptCount = 0;
	/** Open `invoke_agent pi` span per conversation scope. */
	const agentKeys = new Map<string, string>();
	/** Open runs, for matching child conversations to them. */
	const runs = new Map<string, RunInfo>();
	/** Span each matched child conversation hangs under, by scope key. */
	const childParents = new Map<string, string>();
	/** Child conversations whose run is not known yet, replayed once it is. */
	const pendingChildren = new Map<string, { scope: ChildScope; events: ConversationEvent[] }>();

	const ensureRoot = () => {
		if (!tracer.isOpen(ROOT_KEY)) {
			tracer.start(ROOT_KEY, ROOT_SPAN_NAME, { "gen_ai.conversation.id": conversationId() });
		}
		return ROOT_KEY;
	};

	/** The parent's open `invoke_agent pi` span, or the root between prompts. */
	const parentAgentKey = () => {
		const key = agentKeys.get("parent");
		return key && tracer.isOpen(key) ? key : ensureRoot();
	};

	// ---------------------------------------------------------------------------
	// Conversations
	// ---------------------------------------------------------------------------

	const conversation = (scopeKey: string, parentKey: string, event: ConversationEvent, extra: SpanAttributes = {}) => {
		const key = (kind: string, id: string) => `${scopeKey}:${kind}:${id}`;
		switch (event.kind) {
			case "agent.start": {
				promptCount++;
				const agentKey = key("agent", String(promptCount));
				agentKeys.set(scopeKey, agentKey);
				tracer.start(
					agentKey,
					"invoke_agent pi",
					{
						"gen_ai.operation.name": "invoke_agent",
						"gen_ai.agent.name": "pi",
						"gen_ai.conversation.id": conversationId(),
						...extra,
					},
					{ parentKey, startTimeMs: event.timeMs },
				);
				return;
			}
			case "agent.end": {
				const agentKey = agentKeys.get(scopeKey);
				if (!agentKey) return;
				agentKeys.delete(scopeKey);
				const messages: unknown[] = Array.isArray(event.messages) ? event.messages : [];
				const firstAssistant = messages.findIndex(isAssistant);
				const last = [...messages].reverse().find(isAssistant);
				tracer.end(agentKey, {
					attributes: {
						"gen_ai.input.messages": JSON.stringify(
							messages.slice(0, firstAssistant === -1 ? messages.length : firstAssistant).map(genAiMessage),
						),
						"gen_ai.output.messages":
							last && isRecord(last) ? outputMessages(last, str(last.stopReason)) : undefined,
					},
					endTimeMs: event.timeMs,
				});
				return;
			}
			case "llm.start":
				tracer.start(
					key("llm", event.callKey),
					event.model ? `chat ${event.model}` : "chat",
					{
						"gen_ai.operation.name": "chat",
						"gen_ai.provider.name": event.provider,
						"gen_ai.request.model": event.model,
						...chatInputAttributes(event.messages),
						...extra,
					},
					{ parentKey, startTimeMs: event.timeMs },
				);
				return;
			case "llm.end":
				tracer.end(key("llm", event.callKey), {
					attributes: {
						...usageAttributes(event.usage),
						"gen_ai.response.model": event.responseModel,
						"gen_ai.response.id": event.responseId,
						"gen_ai.response.finish_reasons": event.stopReason ? [event.stopReason] : undefined,
						"gen_ai.output.messages":
							event.output === undefined ? undefined : outputMessages(event.output, event.stopReason),
					},
					error: event.error,
					endTimeMs: event.timeMs,
				});
				return;
			case "tool.start":
				tracer.start(
					key("tool", event.toolCallId),
					`execute_tool ${event.toolName}`,
					{
						"gen_ai.operation.name": "execute_tool",
						"gen_ai.tool.name": event.toolName,
						"gen_ai.tool.call.id": event.toolCallId,
						"gen_ai.tool.type": "function",
						"gen_ai.tool.call.arguments":
							event.arguments === undefined ? undefined : JSON.stringify(event.arguments),
						...extra,
					},
					{ parentKey, startTimeMs: event.timeMs },
				);
				return;
			case "tool.end":
				tracer.end(key("tool", event.toolCallId), {
					attributes: {
						"gen_ai.tool.call.result": event.result === undefined ? undefined : JSON.stringify(event.result),
					},
					error: event.isError ? { type: "tool_error" } : undefined,
					endTimeMs: event.timeMs,
				});
				return;
		}
	};

	// ---------------------------------------------------------------------------
	// Matching child conversations to runs
	// ---------------------------------------------------------------------------

	/** The run's span, or for a workflow the per-agent span for `index`, started on first use. */
	const childParentKey = (run: RunInfo, index: number | undefined) => {
		if (run.mode === "single" || index === undefined) return run.key;
		const key = `${run.key}:${index}`;
		if (!tracer.isOpen(key)) {
			const child = agentSpan(run.agents?.[index]);
			tracer.start(
				key,
				child.name,
				{ ...child.attributes, "pi.subagent.source": run.source, "pi.subagent.index": index },
				{ parentKey: run.key },
			);
		}
		return key;
	};

	const sameFile = (a: string | undefined, b: string | undefined) =>
		a !== undefined && b !== undefined && path.resolve(a) === path.resolve(b);

	/**
	 * pi-subagents lays out child sessions as `<sessionRoot>/run-<index>/session.jsonl`. Failing that,
	 * a foreground child belongs to the only open `subagent` tool call, if there is exactly one.
	 */
	const matchRun = (scope: ChildScope): { run: RunInfo; index: number | undefined } | undefined => {
		const runDir = scope.sessionFile ? path.dirname(scope.sessionFile) : undefined;
		const index = runDir ? Number(/^run-(\d+)$/.exec(path.basename(runDir))?.[1] ?? Number.NaN) : Number.NaN;
		const byRoot = [...runs.values()].find((run) => sameFile(run.sessionRoot, runDir && path.dirname(runDir)));
		if (byRoot) return { run: byRoot, index: Number.isNaN(index) ? undefined : index };
		const toolRuns = [...runs.values()].filter((run) => run.source === "tool");
		return toolRuns.length === 1 ? { run: toolRuns[0], index: Number.isNaN(index) ? undefined : index } : undefined;
	};

	/**
	 * Attach a child conversation to `parentKey` and mark the process boundary there: the run (or
	 * workflow child) span records whether the child shares the parent's process.
	 */
	const bindChild = (scope: ChildScope, parentKey: string) => {
		const scopeKey = childScopeKey(scope);
		childParents.set(scopeKey, parentKey);
		if (scope.pid !== undefined) {
			tracer.setAttributes(parentKey, {
				"pi.subagent.execution": scope.pid === process.pid ? "in_process" : "separate_process",
				"pi.subagent.process.pid": scope.pid,
			});
		}
		const pending = pendingChildren.get(scopeKey);
		pendingChildren.delete(scopeKey);
		for (const event of pending?.events ?? []) conversation(scopeKey, parentKey, event, processAttributes(scope));
	};

	const childConversation = (scope: ChildScope, event: ConversationEvent) => {
		// The run's own span stands for the child's agent invocation.
		if (event.kind === "agent.start" || event.kind === "agent.end") return;
		const scopeKey = childScopeKey(scope);
		const parentKey = childParents.get(scopeKey);
		if (parentKey) {
			conversation(scopeKey, parentKey, event, processAttributes(scope));
			return;
		}
		const pending = pendingChildren.get(scopeKey) ?? { scope, events: [] };
		pending.events.push(event);
		pendingChildren.set(scopeKey, pending);
		const match = matchRun(scope);
		if (match) bindChild(scope, childParentKey(match.run, match.index));
	};

	/** Children waiting for `run`: by session root when it starts, by result rows when it ends. */
	const bindPendingChildren = (run: RunInfo, results: UnknownRecord[] = []) => {
		for (const pending of pendingChildren.values()) {
			const row = results.findIndex((result) =>
				sameFile(str(result.sessionFile) ?? str(result.sessionPath), pending.scope.sessionFile),
			);
			if (row !== -1) {
				bindChild(pending.scope, childParentKey(run, row));
				continue;
			}
			const match = matchRun(pending.scope);
			if (match?.run.key === run.key && run.sessionRoot) bindChild(pending.scope, childParentKey(run, match.index));
		}
	};

	// ---------------------------------------------------------------------------
	// Subagent runs
	// ---------------------------------------------------------------------------

	const startRun = (run: RunInfo, startTimeMs?: number) => {
		runs.set(run.key, run);
		const launchKey = run.launchToolCallId ? `parent:tool:${run.launchToolCallId}` : undefined;
		const parentKey = launchKey && tracer.isOpen(launchKey) ? launchKey : parentAgentKey();
		const workflow = `subagent.${run.mode}`;
		const span =
			run.mode === "single"
				? agentSpan(run.agent, run.description)
				: {
						name: `invoke_workflow ${workflow}`,
						attributes: { "gen_ai.operation.name": "invoke_workflow", "gen_ai.workflow.name": workflow },
					};
		tracer.start(
			run.key,
			span.name,
			{
				...span.attributes,
				"gen_ai.input.messages": textMessages("user", run.input),
				"pi.subagent.id": run.id,
				"pi.subagent.source": run.source,
				"pi.subagent.launch_tool_call_id": run.launchToolCallId,
				...run.attributes,
				"pi.subagent.mode": run.mode,
			},
			{ parentKey, startTimeMs },
		);
	};

	// Results arrive only at the end, so workflow children span the whole run.
	const endRun = (run: RunInfo, outcome: RunOutcome, results: UnknownRecord[] | undefined) => {
		if (!results) {
			tracer.end(run.key, spanEnd(outcome));
			return;
		}
		if (run.mode === "single") {
			const row = results[0] ? resultOutcome(results[0]) : {};
			tracer.end(
				run.key,
				spanEnd({
					usage: row.usage,
					output: outcome.output ?? row.output,
					attributes: { ...row.attributes, ...outcome.attributes },
					error: outcome.error ?? row.error,
				}),
			);
			return;
		}
		const startTimeMs = tracer.startTimeOf(run.key);
		let failures = 0;
		for (const [index, result] of results.entries()) {
			const childKey = `${run.key}:${index}`;
			const child = agentSpan(str(result.agent));
			const childOutcome = resultOutcome(result);
			if (childOutcome.error) failures++;
			tracer.start(
				childKey,
				child.name,
				{ ...child.attributes, "pi.subagent.source": run.source },
				{ parentKey: run.key, startTimeMs },
			);
			tracer.end(childKey, spanEnd(childOutcome));
		}
		tracer.end(
			run.key,
			spanEnd({
				usage: sumUsage(results),
				output: outcome.output,
				attributes: { "pi.subagent.failed_count": failures, ...outcome.attributes },
				error:
					outcome.error ??
					(failures > 0 ? { type: "subagent_failed", message: `${failures} subagent(s) failed` } : undefined),
			}),
		);
	};

	return {
		get dropped() {
			return dropped;
		},

		handle(event) {
			switch (event.kind) {
				case "conversation":
					if (event.scope.kind === "parent") conversation("parent", parentAgentKey(), event.event);
					else childConversation(event.scope, event.event);
					return;
				case "start":
					if (tracer.isOpen(event.run.key)) {
						tracer.addEvent(event.run.key, "pi.subagent.duplicate_start");
						return;
					}
					startRun(event.run);
					bindPendingChildren(event.run);
					return;
				case "end":
					if (!tracer.isOpen(event.run.key)) {
						// Finished without a start we saw (we loaded after it started): rebuild from durationMs.
						if (event.durationMs === undefined) return;
						startRun(
							{ ...event.run, attributes: { ...event.run.attributes, "pi.subagent.orphan": true } },
							now() - event.durationMs,
						);
					}
					// Replay any child conversations of this run before it closes.
					bindPendingChildren(runs.get(event.run.key) ?? event.run, event.results);
					runs.delete(event.run.key);
					endRun(event.run, event.outcome, event.results);
					return;
				case "event":
					tracer.addEvent(event.key, event.name, event.attributes);
					return;
				case "discard":
					runs.delete(event.key);
					tracer.discard(event.key, { "pi.subagent.discarded": event.reason });
					return;
				case "malformed":
					dropped++;
					return;
			}
		},

		shutdown(errorType) {
			// Child conversations never matched to a run: keep them, under the root.
			for (const [scopeKey, pending] of pendingChildren) {
				const extra = {
					...processAttributes(pending.scope),
					"pi.subagent.unattributed": true,
					"pi.subagent.session_file": pending.scope.sessionFile,
				};
				for (const event of pending.events) conversation(scopeKey, ensureRoot(), event, extra);
			}
			pendingChildren.clear();
			childParents.clear();
			runs.clear();
			// Children first, so each span ends before its parent.
			for (const key of tracer.openKeys().reverse()) {
				if (key === ROOT_KEY) continue;
				tracer.end(key, { error: { type: errorType, message: "span still open when the session ended" } });
			}
			tracer.end(ROOT_KEY);
		},
	};
}
