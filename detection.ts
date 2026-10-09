/**
 * Whether a subagent extension is on the bus. Without this, an empty trace is ambiguous:
 * no subagents ran, or no extension is there to report them.
 */

import { piSubagents } from "./sources/pi-subagents.ts";
import { tintinweb } from "./sources/tintinweb.ts";
import type { Detection, PackageSource, SubagentSourceStatus } from "./types.ts";

/** Subagent packages traced over the event bus, in probe order. */
export const PACKAGE_SOURCES: readonly PackageSource[] = [tintinweb, piSubagents];

export function createDetection(onChange: () => void): Detection {
	let status: SubagentSourceStatus = { state: "unknown" };
	let probeTimer: ReturnType<typeof setTimeout> | undefined;

	const mark: Detection["mark"] = (source, via, version) => {
		if (status.package && status.package !== source.package) return;
		const knownVersion = version ?? status.version;
		status = {
			state: knownVersion !== undefined && knownVersion !== source.protocolVersion ? "incompatible" : "detected",
			package: source.package,
			via: status.via ?? via,
			version: knownVersion,
		};
		onChange();
	};

	return {
		get status() {
			return status;
		},
		mark,

		probe(pi, timeoutMs, onAbsent) {
			if (status.state !== "unknown") return;
			// No reply within the timeout means no package is loaded (yet);
			// a ready signal or any lifecycle event flips the state later.
			const unsubscribers = PACKAGE_SOURCES.map((source) =>
				source.ping(pi, (version) => mark(source, "ping", version)),
			);
			probeTimer = setTimeout(() => {
				for (const off of unsubscribers) off();
				if (status.state !== "unknown") return;
				status = { state: "absent" };
				onChange();
				onAbsent();
			}, timeoutMs);
			probeTimer.unref?.();
		},

		stop() {
			if (probeTimer) clearTimeout(probeTimer);
		},
	};
}
