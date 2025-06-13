import { PeerRecord, RecordEnvelope } from "@libp2p/peer-record"

export function assert(condition: unknown, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message ?? "assertion failed")
	}
}

export function decodePeerRecord(signedPeerRecord: Uint8Array): PeerRecord {
	const envelope = RecordEnvelope.createFromProtobuf(signedPeerRecord)
	return PeerRecord.createFromProtobuf(envelope.payload)
}
