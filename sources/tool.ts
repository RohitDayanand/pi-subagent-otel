/**
 * `tool_execution_start/end` of the `subagent` tool, which both the bundled example and
 * pi-subagents register. Covers foreground runs; background launches are left to the
 * pi-subagents source.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, str } from "../parse.ts";
import type { SourceEvent, UnknownRecord } from "../types.ts";

export function subscribeToSubagentTool(
	pi: ExtensionAPI,
	emit: (event: SourceEvent) => void,
	toolNames: ReadonlySet<string>,
): void {
	pi.on("tool_execution_start", (event) => {
		if (!toolNames.has(event.toolName)) return;
		const args: UnknownRecord = isRecord(event.args) ? event.args : {};
		// pi-subagents management calls (status, list, stop, ...) are not invocations.
		if (str(args.action)) return;
		const mode = Array.isArray(args.chain)
			? "chain"
			: Array.isArray(args.tasks)
				? "parallel"
				: str(args.workflow) || str(args.workflowScript) || str(args.workflowScriptPath)
					? "workflow"
					: "single";
		const steps = mode === "chain" ? args.chain : mode === "parallel" ? args.tasks : undefined;
		const agents = Array.isArray(steps)
			? steps.map((step) => (isRecord(step) ? (str(step.agent) ?? "") : ""))
			: undefined;
		emit({
			kind: "start",
			run: {
				key: `tool:${event.toolCallId}`,
				id: event.toolCallId,
				source: "tool",
				mode,
				agent: str(args.agent),
				input: str(args.task),
				launchToolCallId: event.toolCallId,
				agents,
				attributes: { "pi.subagent.count": Array.isArray(steps) ? steps.length : undefined },
			},
		});
	});

	pi.on("tool_execution_end", (event) => {
		if (!toolNames.has(event.toolName)) return;
		const key = `tool:${event.toolCallId}`;
		const details = isRecord(event.result) && isRecord(event.result.details) ? event.result.details : undefined;
		const mode = str(details?.mode);
		// A background launch returns immediately; the run is traced from subagent:async-* instead.
		if (details && (str(details.asyncId) || details.background === true)) {
			emit({ kind: "discard", key, reason: "async_launch" });
			return;
		}
		if (mode === "management") {
			emit({ kind: "discard", key, reason: "management" });
			return;
		}
		// No durationMs: an end for a call whose start we never saw is ignored.
		emit({
			kind: "end",
			run: { key, id: event.toolCallId, source: "tool", mode: mode ?? "single" },
			outcome: { error: event.isError ? { type: "tool_error" } : undefined },
			// Unknown result shape (other tool version, validation error): close without child spans.
			results:
				mode === undefined ? undefined : Array.isArray(details?.results) ? details.results.filter(isRecord) : [],
		});
	});
}
