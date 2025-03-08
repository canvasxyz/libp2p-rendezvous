import type { PeerId } from "@libp2p/interface"
import { PeerRecord, RecordEnvelope } from "@libp2p/peer-record"
import { Multiaddr } from "@multiformats/multiaddr"

export function assert(condition: unknown, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message ?? "assertion failed")
	}
}

export async function parseRecord(signedPeerRecord: Uint8Array): Promise<{ peerId: PeerId; multiaddrs: Multiaddr[] }> {
	const envelope = await RecordEnvelope.createFromProtobuf(signedPeerRecord)
	const { peerId, multiaddrs } = PeerRecord.createFromProtobuf(envelope.payload)
	return { peerId, multiaddrs }
}
