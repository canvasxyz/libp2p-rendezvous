import test from "ava"
import { generateKeyPair } from "@libp2p/crypto/keys"
import { RegistrationStore } from "@canvas-js/libp2p-rendezvous/server"
import { peerIdFromPrivateKey } from "@libp2p/peer-id"
import { PeerRecord, RecordEnvelope } from "@libp2p/peer-record"
import { multiaddr } from "@multiformats/multiaddr"

test.serial("RegistrationStore", async (t) => {
	const store = new RegistrationStore(null)
	t.teardown(() => store.close())

	const privateKey = await generateKeyPair("Ed25519")
	const peerId = peerIdFromPrivateKey(privateKey)

	const namespace = "app.example.com"

	const multiaddrs = [multiaddr("/ip4/127.0.0.1/tcp/8080")]
	const peerRecord = new PeerRecord({ peerId, multiaddrs })
	const envelope = await RecordEnvelope.seal(peerRecord, privateKey)
	const signedPeerRecord = Buffer.from(envelope.marshal())

	const ttl = 1000n
	store.register(namespace, peerId, signedPeerRecord, ttl)

	const result1 = store.discover(namespace, 10n, null)
	t.deepEqual(result1.registrations, [{ ns: namespace, signedPeerRecord, ttl }])

	const result2 = store.discover(namespace, 10n, result1.cookie)
	t.deepEqual(result2.registrations, [])
	t.log("result1.cookie", Buffer.from(result1.cookie).toString("hex"))
	t.log("result2.cookie", Buffer.from(result2.cookie).toString("hex"))
})
