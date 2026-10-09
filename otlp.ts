/**
 * Trace file -> OTLP/JSON (`ExportTraceServiceRequest`), for any OTLP backend such as Jaeger.
 *
 * Differences from the live trace, all possible because OTLP takes explicit times, kinds and links:
 *   - Exact start/end times for every span, including child spans delivered late.
 *   - Process boundary: one OTLP resource per (service, process) with `service.name`, `process.pid`,
 *     `host.name` and `pi.process.role` (`main` for the pi process, `subagent_runner` for an async runner). `service.name` is `pi` for the parent and
 *     `pi-subagent:<agent>` for spans inside a subagent's conversation. A run whose child runs in
 *     another process (`pi.subagent.execution=separate_process`) gets span kind CLIENT.
 *   - Span links: an async run links to the `execute_tool subagent` call that launched it.
 *   - Readable content: each `chat` span gets one event per new input message and per output part
 *     (reasoning, text, tool call), so trace UIs show the conversation as logs instead of one JSON tag.
 *     The content attributes stay as they are.
 */

import type { AttributeValue } from "@earendil-works/pi-telemetry";
import type { SubagentTraceEvent, SubagentTraceSpan, TraceFileRecord } from "./types.ts";

type OtlpAnyValue =
	| { stringValue: string }
	| { boolValue: boolean }
	| { intValue: string }
	| { doubleValue: number }
	| { arrayValue: { values: OtlpAnyValue[] } };

interface OtlpKeyValue {
	key: string;
	value: OtlpAnyValue;
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	/** 1 INTERNAL, 3 CLIENT. */
	kind: 1 | 3;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpKeyValue[];
	events: { timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }[];
	links: { traceId: string; spanId: string; attributes: OtlpKeyValue[] }[];
	status: { code: 0 | 1 | 2; message?: string };
}

export interface OtlpTraceRequest {
	resourceSpans: {
		resource: { attributes: OtlpKeyValue[] };
		scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
	}[];
}

function anyValue(value: AttributeValue): OtlpAnyValue {
	if (Array.isArray(value)) return { arrayValue: { values: value.map((item: AttributeValue) => anyValue(item)) } };
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value as number };
}

const keyValues = (attributes: Record<string, AttributeValue>): OtlpKeyValue[] =>
	Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }));

const nanos = (ms: number) => `${BigInt(Math.round(ms * 1000)) * 1000n}`;

function parseJson(value: AttributeValue | undefined): unknown {
	if (typeof value !== "string") return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Service per span: spans below a subagent's `invoke_agent` span (its conversation) belong to that
 * subagent; everything else to the parent.
 */
function serviceNames(spans: readonly SubagentTraceSpan[]): Map<string, string> {
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const services = new Map<string, string>();
	const serviceOf = (span: SubagentTraceSpan): string => {
		const known = services.get(span.spanId);
		if (known) return known;
		const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
		let service = "pi";
		if (parent) {
			const parentIsRun =
				parent.attributes["gen_ai.operation.name"] === "invoke_agent" &&
				parent.attributes["pi.subagent.source"] !== undefined;
			service = parentIsRun ? `pi-subagent:${parent.attributes["gen_ai.agent.name"] ?? "agent"}` : serviceOf(parent);
		}
		services.set(span.spanId, service);
		return service;
	};
	for (const span of spans) serviceOf(span);
	return services;
}

/**
 * `execute_tool subagent` spans that launched an async run, by run id. The run itself can't record its
 * launch call: `subagent:async-started` fires before the tool call returns the run id.
 */
function asyncLaunchSpans(spans: readonly SubagentTraceSpan[]): Map<string, SubagentTraceSpan> {
	const launches = new Map<string, SubagentTraceSpan>();
	for (const span of spans) {
		if (span.attributes["gen_ai.tool.name"] !== "subagent") continue;
		const result = parseJson(span.attributes["gen_ai.tool.call.result"]);
		const details = isObject(result) ? result.details : undefined;
		if (!isObject(details)) continue;
		const id = typeof details.asyncId === "string" ? details.asyncId : details.runId;
		if (typeof id === "string") launches.set(id, span);
	}
	return launches;
}

/**
 * Conversation events for a `chat` span: input messages new since the model's previous turn (after the
 * last assistant message) at the start, then each output part at the end.
 */
function chatEvents(span: SubagentTraceSpan): SubagentTraceEvent[] {
	const input = parseJson(span.attributes["gen_ai.input.messages"]);
	const output = parseJson(span.attributes["gen_ai.output.messages"]);
	const events: SubagentTraceEvent[] = [];
	if (Array.isArray(input)) {
		const lastAssistant = input.map((message) => isObject(message) && message.role).lastIndexOf("assistant");
		for (const message of input.slice(lastAssistant + 1)) {
			if (!isObject(message) || !Array.isArray(message.parts)) continue;
			for (const part of message.parts) {
				if (!isObject(part)) continue;
				events.push({
					name: "gen_ai.content.input",
					timeMs: span.startTimeMs,
					attributes: {
						role: String(message.role),
						type: String(part.type),
						content: asText(part.content ?? part.response ?? part),
					},
				});
			}
		}
	}
	const parts = Array.isArray(output) && isObject(output[0]) && Array.isArray(output[0].parts) ? output[0].parts : [];
	for (const part of parts) {
		if (!isObject(part)) continue;
		const endMs = span.endTimeMs ?? span.startTimeMs;
		if (part.type === "reasoning") {
			// Providers such as OpenAI return only a summary of the reasoning, sometimes empty; the rest is encrypted.
			const content = asText(part.content);
			events.push({
				name: "gen_ai.content.reasoning",
				timeMs: endMs,
				attributes: { content: content.length > 0 ? content : "(provider returned no reasoning summary)" },
			});
		} else if (part.type === "tool_call") {
			events.push({
				name: "gen_ai.content.tool_call",
				timeMs: endMs,
				attributes: { name: String(part.name), id: String(part.id), arguments: asText(part.arguments) },
			});
		} else {
			events.push({ name: "gen_ai.content.output", timeMs: endMs, attributes: { content: asText(part.content) } });
		}
	}
	return events;
}

export function toOtlp(records: readonly TraceFileRecord[]): OtlpTraceRequest {
	const spans = records.flatMap((record) => (record.type === "span" ? [record.span] : []));
	const parentProcess = records.flatMap((record) => (record.type === "trace" ? [record.process] : []))[0];
	const services = serviceNames(spans);
	const asyncLaunches = asyncLaunchSpans(spans);
	const toolSpans = new Map(
		spans.flatMap((span) => {
			const callId = span.attributes["gen_ai.tool.call.id"];
			return typeof callId === "string" ? [[callId, span] as const] : [];
		}),
	);

	const resources = new Map<string, { attributes: Record<string, AttributeValue>; spans: OtlpSpan[] }>();
	for (const span of spans) {
		const launchCall = span.attributes["pi.subagent.launch_tool_call_id"];
		const runId = span.attributes["pi.subagent.id"];
		const launch =
			typeof launchCall === "string"
				? toolSpans.get(launchCall)
				: span.attributes["pi.subagent.background"] === true && typeof runId === "string"
					? asyncLaunches.get(runId)
					: undefined;
		const events = [...span.events, ...(span.attributes["gen_ai.operation.name"] === "chat" ? chatEvents(span) : [])];
		const otlpSpan: OtlpSpan = {
			traceId: span.traceId,
			spanId: span.spanId,
			...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
			name: span.name,
			kind: span.attributes["pi.subagent.execution"] === "separate_process" ? 3 : 1,
			startTimeUnixNano: nanos(span.startTimeMs),
			endTimeUnixNano: nanos(span.endTimeMs ?? span.startTimeMs),
			attributes: keyValues(span.attributes),
			events: events
				.sort((a, b) => a.timeMs - b.timeMs)
				.map((event) => ({
					timeUnixNano: nanos(event.timeMs),
					name: event.name,
					attributes: keyValues(event.attributes),
				})),
			links:
				launch && launch.spanId !== span.parentSpanId
					? [
							{
								traceId: launch.traceId,
								spanId: launch.spanId,
								attributes: keyValues({ "pi.link.type": "launched_by" }),
							},
						]
					: [],
			status:
				span.status.code === "ERROR"
					? { code: 2, ...(span.status.message ? { message: span.status.message } : {}) }
					: { code: span.status.code === "OK" ? 1 : 0 },
		};
		const service = services.get(span.spanId) ?? "pi";
		const spanPid = span.attributes["process.pid"];
		const pid = typeof spanPid === "number" ? spanPid : parentProcess?.pid;
		const resourceKey = `${service}\u0000${pid ?? ""}`;
		const resource = resources.get(resourceKey) ?? {
			attributes: {
				"service.name": service,
				...(pid !== undefined ? { "process.pid": pid } : {}),
				...(parentProcess ? { "host.name": parentProcess.hostname } : {}),
				"pi.process.role": pid === undefined || pid === parentProcess?.pid ? "main" : "subagent_runner",
			},
			spans: [],
		};
		resource.spans.push(otlpSpan);
		resources.set(resourceKey, resource);
	}

	return {
		resourceSpans: [...resources.values()].map((resource) => ({
			resource: { attributes: keyValues(resource.attributes) },
			scopeSpans: [{ scope: { name: "subagent-otel" }, spans: resource.spans }],
		})),
	};
}
