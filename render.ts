import { PACKAGE_SOURCES } from "./detection.ts";
import type { SubagentSourceStatus, SubagentTrace, SubagentTraceSpan } from "./types.ts";

function sourceLabel(source: SubagentSourceStatus): string {
	const version = source.version !== undefined ? ` v${source.version}` : "";
	return `${source.package ?? "subagent extension"}${version}`;
}

function describeSource(source: SubagentSourceStatus): string {
	switch (source.state) {
		case "detected":
			return `${sourceLabel(source)} detected via ${source.via}`;
		case "incompatible": {
			const expected = PACKAGE_SOURCES.find((candidate) => candidate.package === source.package)?.protocolVersion;
			return `${sourceLabel(source)} (expected v${expected ?? "?"}); tracing its events best-effort`;
		}
		case "absent":
			return "no subagent extension on the bus (checked @tintinweb/pi-subagents and pi-subagents); tracing the `subagent` tool only";
		default:
			return "subagent extension detection pending";
	}
}

/** One-line footer status: detection state plus the number of finished subagent spans. */
export function statusText(trace: SubagentTrace): string {
	const finished = trace.spans.filter(
		(span) => span.attributes["pi.subagent.source"] !== undefined && span.endTimeMs !== undefined,
	).length;
	const spans = `${finished} span${finished === 1 ? "" : "s"}`;
	const { source } = trace;
	switch (source.state) {
		case "detected":
			return `otel: ${sourceLabel(source)} · ${spans}`;
		case "incompatible":
			return `otel: ${sourceLabel(source)} unsupported version · ${spans}`;
		case "absent":
			return `otel: no subagent extension · ${spans}`;
		default:
			return "otel: probing for subagent extensions";
	}
}

/** Span tree with duration, status, token counts and cost per span. */
export function renderTrace(trace: SubagentTrace): string {
	const lines = [`trace ${trace.traceId}`, describeSource(trace.source)];
	if (trace.file) lines.push(`full trace: ${trace.file}`);
	if (trace.dropped > 0) lines.push(`${trace.dropped} malformed subagent event(s) dropped`);
	if (trace.spans.length === 0) {
		lines.push("no subagent invocations recorded");
		return lines.join("\n");
	}
	const children = new Map<string | undefined, SubagentTraceSpan[]>();
	for (const span of trace.spans) {
		const siblings = children.get(span.parentSpanId) ?? [];
		siblings.push(span);
		children.set(span.parentSpanId, siblings);
	}
	const describe = (span: SubagentTraceSpan) => {
		const parts = [span.name];
		parts.push(span.endTimeMs === undefined ? "open" : `${((span.endTimeMs - span.startTimeMs) / 1000).toFixed(1)}s`);
		if (span.status.code === "ERROR") parts.push(`ERROR(${span.attributes["error.type"] ?? "_OTHER"})`);
		else if (span.status.code === "OK") parts.push("OK");
		const input = span.attributes["gen_ai.usage.input_tokens"];
		const output = span.attributes["gen_ai.usage.output_tokens"];
		if (input !== undefined || output !== undefined) parts.push(`in=${input ?? 0} out=${output ?? 0}`);
		const cost = span.attributes["pi.usage.cost_usd"];
		if (typeof cost === "number" && cost > 0) parts.push(`$${cost.toFixed(4)}`);
		return parts.join("  ");
	};
	const walk = (span: SubagentTraceSpan, prefix: string, isLast: boolean, isRoot: boolean) => {
		lines.push(isRoot ? describe(span) : `${prefix}${isLast ? "└─ " : "├─ "}${describe(span)}`);
		const kids = children.get(span.spanId) ?? [];
		const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
		for (const [index, kid] of kids.entries()) walk(kid, childPrefix, index === kids.length - 1, false);
	};
	for (const root of children.get(undefined) ?? []) walk(root, "", true, true);
	return lines.join("\n");
}
