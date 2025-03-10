import { ExecutionContext } from "ava"

import { createLibp2p, Libp2pOptions } from "libp2p"
import { generateKeyPair } from "@libp2p/crypto/keys"
import { yamux } from "@chainsafe/libp2p-yamux"
import { noise } from "@chainsafe/libp2p-noise"
import { webSockets } from "@libp2p/websockets"
import { Identify, identify } from "@libp2p/identify"
import { Libp2p, ServiceMap } from "@libp2p/interface"

export interface Config {
	port: number
	name?: string
	start?: boolean
}

export async function getLibp2p<T extends ServiceMap>(
	t: ExecutionContext,
	config: Config,
	services: Libp2pOptions<T>["services"],
): Promise<Libp2p<T & { identify: Identify }>> {
	const privateKey = await generateKeyPair("Ed25519")

	const { port, start = true } = config

	const libp2p = await createLibp2p({
		privateKey,
		start: false,
		addresses: {
			listen: [`/ip4/127.0.0.1/tcp/${port}/ws`],
			announce: [`/ip4/127.0.0.1/tcp/${port}/ws`],
		},
		transports: [webSockets({})],
		connectionGater: { denyDialMultiaddr: (addr) => false },
		connectionMonitor: { enabled: false },
		streamMuxers: [yamux()],
		connectionEncrypters: [noise({})],
		services: {
			...services,
			identify: identify({ protocolPrefix: "canvas" }),
		},
	})

	t.teardown(() => libp2p.stop())

	if (start) {
		await libp2p.start()
	}

	return libp2p as Libp2p<T & { identify: Identify }>
}
