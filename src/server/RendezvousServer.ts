import { PeerId, Startable, TypedEventTarget, Libp2pEvents, PeerStore, StreamHandler } from "@libp2p/interface"
import { Registrar, AddressManager, ConnectionManager } from "@libp2p/interface-internal"
import { logger } from "@libp2p/logger"

import { Multiaddr } from "@multiformats/multiaddr"
import * as lp from "it-length-prefixed"
import { pipe } from "it-pipe"

import { Message, decodeMessages, encodeMessages } from "@canvas-js/libp2p-rendezvous/protocol"
import { RegistrationStore } from "./RegistrationStore.js"
import { assert, decodePeerRecord } from "./utils.js"

const clamp = (val: bigint, max: bigint) => (val > max ? max : val)

export type RendezvousServerComponents = {
	events: TypedEventTarget<Libp2pEvents>
	peerId: PeerId
	peerStore: PeerStore
	registrar: Registrar
	addressManager: AddressManager
	connectionManager: ConnectionManager
}

export interface RendezvousServerInit {
	path?: string | null
	maxRegistrationTTL?: number
	maxDiscoverLimit?: number
	discoverFilter?: (namespace: string, peerId: PeerId, multiaddrs: Multiaddr[]) => boolean
}

export class RendezvousServer implements Startable {
	public static protocol = "/canvas/rendezvous/1.0.0"

	public readonly store: RegistrationStore
	public readonly maxRegistrationTTL: bigint
	public readonly maxDiscoverLimit: bigint
	public readonly discoverFilter?: (namespace: string, peerId: PeerId, multiaddrs: Multiaddr[]) => boolean
	private readonly log = logger(`canvas:rendezvous:server`)

	#started: boolean = false

	constructor(
		private readonly components: RendezvousServerComponents,
		init: RendezvousServerInit,
	) {
		this.store = new RegistrationStore(init.path ?? null)

		// 2h
		this.maxRegistrationTTL = BigInt(init.maxRegistrationTTL ?? 2 * 60 * 60) // 2h
		this.maxDiscoverLimit = BigInt(init.maxDiscoverLimit ?? 64)
		this.discoverFilter = init.discoverFilter
	}

	public isStarted() {
		return this.#started
	}

	public async beforeStart() {
		this.log("beforeStart")
		await this.components.registrar.handle(RendezvousServer.protocol, this.handleIncomingStream)
	}

	public async start() {
		this.log("start")
		this.#started = true
	}

	public async afterStart() {
		this.log("afterStart")
	}

	public async beforeStop() {
		this.log("beforeStop")
		await this.components.registrar.unhandle(RendezvousServer.protocol)
	}

	public async stop() {
		this.log("stop")
		this.store.close()
		this.#started = false
	}

	public afterStop(): void {}

	private handleIncomingStream: StreamHandler = ({ stream, connection }) => {
		this.log("opened incoming rendezvous stream %s from peer %p", stream.id, connection.remotePeer)
		const handle = (reqs: AsyncIterable<Message>) => this.handleMessages(connection.remotePeer, reqs)
		pipe(stream, lp.decode, decodeMessages, handle, encodeMessages, lp.encode, stream).then(
			() => this.log("closed incoming rendezvous stream %s", stream.id),
			(err) => {
				this.log.error("error handling requests: %O", err)
				stream.abort(err)
			},
		)
	}

	private async *handleMessages(peerId: PeerId, reqs: AsyncIterable<Message>): AsyncIterable<Message> {
		for await (const req of reqs) {
			this.log.trace("handling request: %O", req)
			if (req.type === Message.MessageType.REGISTER) {
				assert(req.register !== undefined, "invalid REGISTER message")
				const { ns, signedPeerRecord, ttl } = req.register
				assert(ns.length < 256, "invalid namespace (expected ns.length < 256)")

				this.log("REGISTER ns %s, ttl %d (%p)", ns, ttl, peerId)

				const actualTTL = ttl === 0n ? this.maxRegistrationTTL : clamp(ttl, this.maxRegistrationTTL)

				await this.components.peerStore.consumePeerRecord(signedPeerRecord, { expectedPeer: peerId })

				this.store.register(ns, peerId, signedPeerRecord, actualTTL)

				const res: Message = {
					type: Message.MessageType.REGISTER_RESPONSE,
					registerResponse: { status: Message.ResponseStatus.OK, statusText: "OK", ttl: actualTTL },
				}

				this.log.trace("yielding response: %O", res)
				yield res
			} else if (req.type === Message.MessageType.UNREGISTER) {
				assert(req.unregister !== undefined, "invalid UNREGISTER message")
				const { ns } = req.unregister
				assert(ns.length < 256, "invalid namespace (expected ns.length < 256)")

				this.log("UNREGISTER ns %s (%p)", ns, peerId)

				this.store.unregister(ns, peerId)
			} else if (req.type === Message.MessageType.DISCOVER) {
				assert(req.discover !== undefined, "invalid DISCOVER message")
				const { ns, limit, cookie } = req.discover
				assert(ns.length < 256, "invalid namespace (expected ns.length < 256)")

				this.log("DISCOVER ns %s, limit %d (%p)", ns, limit, peerId)

				const actualLimit = limit === 0n ? this.maxDiscoverLimit : clamp(limit, this.maxDiscoverLimit)

				const result = this.store.discover(
					ns,
					actualLimit,
					cookie.byteLength === 0 ? null : cookie,
					this.discoverFilter,
				)

				const res: Message = {
					type: Message.MessageType.DISCOVER_RESPONSE,
					discoverResponse: {
						status: Message.ResponseStatus.OK,
						statusText: "OK",
						registrations: result.registrations,
						cookie: result.cookie,
					},
				}

				this.log.trace("yielding response: %O", res)
				yield res
			} else {
				throw new Error("invalid request message type")
			}
		}
	}
}

export const rendezvousServer =
	(init: RendezvousServerInit = {}) =>
	(components: RendezvousServerComponents) =>
		new RendezvousServer(components, init)
