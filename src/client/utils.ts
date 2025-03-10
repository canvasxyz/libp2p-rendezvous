import { anySignal } from "any-signal"

export function assert(condition: unknown, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message ?? "assertion failed")
	}
}

export async function wait(interval: number, options: { signal: AbortSignal }): Promise<void> {
	if (options.signal.aborted) {
		return
	}

	const signal = anySignal([AbortSignal.timeout(interval), options.signal])
	await new Promise<Event>((resolve) => {
		signal.addEventListener("abort", resolve, { once: true })
	}).finally(() => signal.clear())
}
