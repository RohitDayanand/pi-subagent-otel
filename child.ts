/**
 * Runs inside each pi-subagents child (registered by `child-registration.ts`). Streams the child's
 * conversation to the parent: directly when the parent is in this process (foreground children),
 * over the fleet socket otherwise (async runners). No tracer and no OTel names here: the parent maps
 * events to spans. Inert when no socket path is set.
 */

import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribeToConversation } from "./sources/conversation.ts";
import { connectInProcess, FLEET_SOCKET_ENV } from "./sources/fleet-ipc.ts";
import type { FleetMessage } from "./types.ts";

export default function subagentOtelChild(pi: ExtensionAPI) {
	const socketPath = process.env[FLEET_SOCKET_ENV];
	if (!socketPath) return;
	let socket: net.Socket | undefined;
	let direct: ((message: FleetMessage) => void) | undefined;

	const send = (message: FleetMessage) => {
		try {
			if (direct) direct(message);
			else socket?.write(`${JSON.stringify(message)}\n`);
		} catch {
			// The parent is gone or failed; the child must not be affected.
			socket = undefined;
			direct = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			direct = connectInProcess(socketPath);
			if (!direct) {
				const connection = net.createConnection(socketPath);
				connection.on("error", () => {
					socket = undefined;
				});
				// Never keep the child alive just for the socket.
				connection.unref();
				socket = connection;
			}
		} catch {
			socket = undefined;
			return;
		}
		send({
			v: 1,
			type: "hello",
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			pid: process.pid,
		});
	});

	// Events are stamped here: the parent receives them later and must not use its own clock.
	subscribeToConversation(pi, (event) => send({ v: 1, type: "event", event: { ...event, timeMs: Date.now() } }));

	pi.on("session_shutdown", () => {
		send({ v: 1, type: "bye" });
		socket?.end();
		socket = undefined;
		direct = undefined;
	});
}
