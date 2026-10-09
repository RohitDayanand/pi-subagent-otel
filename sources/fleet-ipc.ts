/**
 * Parent end of the fleet channel. Each subagent's `child.ts` says `hello` with its session, then
 * streams conversation events. Events become conversation events in that child's scope; matching the
 * child to its run is instrumentation's job.
 *
 * Two transports carry the same messages:
 *   - Async runners are separate processes and use a local socket, one JSON object per line. The
 *     socket path reaches them through `process.env` (`FLEET_SOCKET_ENV`), which they inherit.
 *   - Foreground children run in the parent's process. They call the parent's handler directly
 *     (`connectInProcess`), so their events are handled in order with the parent's own, before the
 *     `subagent` tool call that runs them ends. Over the socket they would arrive after it.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, num, str } from "../parse.ts";
import type { ConversationEvent, ConversationScope, FleetMessage, FleetServer, SourceEvent } from "../types.ts";

export const FLEET_SOCKET_ENV = "PI_SUBAGENT_OTEL_SOCKET";

/** In-process connection factories by socket path. On `globalThis` because the child module may be loaded separately. */
const IN_PROCESS_KEY = Symbol.for("subagent-otel.fleet-in-process.v1");

function inProcessServers(): Map<string, () => (message: unknown) => void> {
	const root = globalThis as Record<symbol, unknown>;
	root[IN_PROCESS_KEY] ??= new Map();
	return root[IN_PROCESS_KEY] as Map<string, () => (message: unknown) => void>;
}

/** Direct connection to a fleet server in this process, or undefined when it runs elsewhere. */
export function connectInProcess(socketPath: string): ((message: FleetMessage) => void) | undefined {
	return inProcessServers().get(socketPath)?.();
}

function socketPath(): string {
	const name = `pi-otel-${process.pid}-${randomBytes(4).toString("hex")}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

/** Handles one child's messages in order. */
function createConnection(emit: (event: SourceEvent) => void): (message: unknown) => void {
	let scope: ConversationScope | undefined;
	return (message) => {
		if (!isRecord(message) || message.v !== 1) {
			emit({ kind: "malformed" });
		} else if (message.type === "hello") {
			const sessionId = str(message.sessionId);
			scope = sessionId
				? { kind: "child", sessionId, sessionFile: str(message.sessionFile), pid: num(message.pid) }
				: undefined;
		} else if (message.type === "event" && scope && isRecord(message.event)) {
			// Shape is trusted: both ends are this extension.
			emit({ kind: "conversation", scope, event: message.event as ConversationEvent });
		} else if (message.type !== "bye") {
			emit({ kind: "malformed" });
		}
	};
}

export function startFleetServer(emit: (event: SourceEvent) => void): FleetServer {
	const listenPath = socketPath();
	const server = net.createServer((socket) => {
		const handle = createConnection(emit);
		let buffered = "";
		socket.setEncoding("utf8");
		// A child that dies mid-write only loses its own events.
		socket.on("error", () => {});
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (line.length === 0) continue;
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					emit({ kind: "malformed" });
					continue;
				}
				handle(message);
			}
		});
	});
	server.on("error", (error) => console.error("subagent-otel fleet socket error:", error));
	if (process.platform !== "win32") fs.rmSync(listenPath, { force: true });
	server.listen(listenPath);
	// Never keep pi alive just for the socket.
	server.unref();
	inProcessServers().set(listenPath, () => createConnection(emit));
	return {
		path: listenPath,
		close() {
			inProcessServers().delete(listenPath);
			server.close();
			if (process.platform !== "win32") fs.rmSync(listenPath, { force: true });
		},
	};
}
