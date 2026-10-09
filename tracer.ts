import { randomBytes } from "node:crypto";
import type { AttributeValue, SpanAttributes } from "@earendil-works/pi-telemetry";
import type { OpenSpan, SpanEnd, SubagentTraceSpan, Tracer, TracerOptions } from "./types.ts";

function definedAttributes(attributes: SpanAttributes | undefined): Record<string, AttributeValue> {
	const result: Record<string, AttributeValue> = {};
	for (const [key, value] of Object.entries(attributes ?? {})) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

export function createTracer({ telemetry, now, recordAttribute, retainAttribute }: TracerOptions): Tracer {
	const traceId = randomBytes(16).toString("hex");
	/** Every span in start order, keyed by span id. Open spans in full, finished ones as summaries. */
	const spans = new Map<string, SubagentTraceSpan>();
	const open = new Map<string, OpenSpan>();
	const listeners = new Set<(span: Readonly<SubagentTraceSpan>) => void>();

	/** Defined attributes that `recordAttribute` allows: the only ones that reach memory, listeners or telemetry. */
	const recorded = (attributes: SpanAttributes | undefined): Record<string, AttributeValue> => {
		const defined = definedAttributes(attributes);
		if (!recordAttribute) return defined;
		for (const key of Object.keys(defined)) {
			if (!recordAttribute(key)) delete defined[key];
		}
		return defined;
	};

	const retained = (attributes: Record<string, AttributeValue>) => {
		if (!retainAttribute) return attributes;
		const kept: Record<string, AttributeValue> = {};
		for (const [key, value] of Object.entries(attributes)) {
			if (retainAttribute(key)) kept[key] = value;
		}
		return kept;
	};

	const summarize = (record: SubagentTraceSpan): SubagentTraceSpan => ({
		...record,
		attributes: retained(record.attributes),
		events: record.events.map((event) => ({ ...event, attributes: retained(event.attributes) })),
	});

	const settle = (span: OpenSpan, info: SpanEnd) => {
		const { record } = span;
		record.endTimeMs = info.endTimeMs ?? now();
		const attributes = recorded({ ...info.attributes, "error.type": info.error?.type });
		Object.assign(record.attributes, attributes);
		record.status = info.error ? { code: "ERROR", message: info.error.message } : { code: "OK" };
		try {
			span.external?.setAttributes(attributes);
			if (info.error) {
				span.external?.setStatus({
					status: "error",
					error: { name: info.error.type, message: info.error.message ?? info.error.type },
				});
			}
		} catch (error) {
			// Telemetry must never affect the agent.
			console.error("subagent-otel telemetry error:", error);
		}
		span.settle?.();
		for (const listener of listeners) {
			try {
				listener(record);
			} catch (error) {
				// A listener failure must not stop other listeners.
				console.error("subagent-otel listener error:", error);
			}
		}
		spans.set(record.spanId, summarize(record));
	};

	return {
		traceId,
		isOpen: (key) => open.has(key),
		openKeys: () => [...open.keys()],
		startTimeOf: (key) => open.get(key)?.record.startTimeMs,

		start(key, name, attributes, options = {}) {
			if (open.has(key)) return;
			const parent = options.parentKey ? open.get(options.parentKey) : undefined;
			const clean = recorded(attributes);
			const record: SubagentTraceSpan = {
				traceId,
				spanId: randomBytes(8).toString("hex"),
				parentSpanId: parent?.record.spanId,
				name,
				kind: "INTERNAL",
				startTimeMs: options.startTimeMs ?? now(),
				attributes: clean,
				events: [],
				status: { code: "UNSET" },
			};
			spans.set(record.spanId, record);
			const span: OpenSpan = { record };
			open.set(key, span);
			// The telemetry contract has no end(): hold the callback open until settle() resolves it.
			const parentContext = parent ? parent.external : telemetry;
			if (!parentContext) return;
			try {
				void parentContext
					.startSpan({ name, attributes: clean }, (external) => {
						span.external = external;
						return new Promise<void>((resolve) => {
							span.settle = resolve;
						});
					})
					.catch(() => {});
			} catch {
				// A broken adapter only loses the external copy.
			}
		},

		addEvent(key, name, attributes = {}) {
			const span = open.get(key);
			if (!span) return;
			const clean = recorded(attributes);
			span.record.events.push({ name, timeMs: now(), attributes: clean });
			try {
				span.external?.addEvent(name, clean);
			} catch {
				// Telemetry must never affect the agent.
			}
		},

		end(key, info = {}) {
			const span = open.get(key);
			if (!span) return;
			open.delete(key);
			settle(span, info);
		},

		discard(key, attributes) {
			const span = open.get(key);
			if (!span) return;
			open.delete(key);
			spans.delete(span.record.spanId);
			try {
				span.external?.setAttributes(recorded(attributes));
			} catch {
				// Telemetry must never affect the agent.
			}
			span.settle?.();
		},

		setAttributes(key, attributes) {
			const span = open.get(key);
			if (!span) return;
			const clean = recorded(attributes);
			Object.assign(span.record.attributes, clean);
			try {
				span.external?.setAttributes(clean);
			} catch {
				// Telemetry must never affect the agent.
			}
		},

		spans: () => [...spans.values()].map((span) => structuredClone(summarize(span))),

		onSpanEnd(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
