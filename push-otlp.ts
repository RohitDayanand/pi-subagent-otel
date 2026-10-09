#!/usr/bin/env node
/**
 * Push a trace file to an OTLP/HTTP endpoint, e.g. a local Jaeger.
 *
 *   node push-otlp.ts <trace.jsonl> [endpoint]
 *
 * Endpoint defaults to http://localhost:4318/v1/traces.
 */

import * as fs from "node:fs";
import { toOtlp } from "./otlp.ts";
import type { TraceFileRecord } from "./types.ts";

async function main() {
	const [file, endpoint = "http://localhost:4318/v1/traces"] = process.argv.slice(2);
	if (!file) {
		console.error("usage: pi-subagent-otel-push <trace.jsonl> [endpoint]");
		process.exit(2);
	}
	const records = fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as TraceFileRecord);
	const request = toOtlp(records);
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	if (!response.ok) {
		console.error(`push failed: ${response.status} ${await response.text()}`);
		process.exit(1);
	}
	const spans = request.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
	const services = request.resourceSpans.map((resource) => resource.resource.attributes[0]?.value);
	console.log(
		`pushed ${spans.length} spans, trace ${spans[0]?.traceId ?? "(none)"}, services ${JSON.stringify(services)}`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
