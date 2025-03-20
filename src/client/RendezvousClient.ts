import {
	PeerId,
	Startable,
	TypedEventTarget,
	Libp2pEvents,
	PeerStore,
	Peer,
	Connection,
	TypedEventEmitter,
	PeerDiscoveryEvents,
	PrivateKey,
	peerDiscoverySymbol,
	serviceCapabilities,
} from "@libp2p/interface"
import { Registrar, AddressManager, ConnectionManager } from "@libp2p/interface-internal"
import { logger } from "@libp2p/logger"
import { peerIdFromPublicKey } from "@libp2p/peer-id"
import { PeerRecord, RecordEnvelope } from "@libp2p/peer-record"
import { multiaddr, Multiaddr } from "@multiformats/multiaddr"
import { P2P } from "@multiformats/mafmt"

import * as lp from "it-length-prefixed"
import { pipe } from "it-pipe"
import { pushable } from "it-pushable"

import { Message, decodeMessages, encodeMessages } from "@canvas-js/libp2p-rendezvous/protocol"
import { assert, wait } from "./utils.js"

export interface RendezvousPoint {
	discover(namespace: string, options?: { limit?: number }): Promise<Peer[]>
	register(namespace: string, options?: { ttl?: number | null; multiaddrs?: Multiaddr[] }): Promise<{ ttl: number }>
	unregister(namespace: string): Promise<void>
}

export type RendezvousClientComponents = {
	events: TypedEventTarget<Libp2pEvents>
	peerId: PeerId
	peerStore: PeerStore
	registrar: Registrar
	addressManager: AddressManager
	connectionManager: ConnectionManager
	privateKey: PrivateKey
}

export interface RendezvousClientInit {
	autoRegister?: {
		/** namespaces to auto-register */
		namespaces: string[]
		/** rendezvous point multiaddrs */
		multiaddrs: string[]

		/** registration TTL, in seconds */
		ttl?: number
		/** initial timeout before connecting, in milliseconds */
		initialTimeout?: number
		/** retry interval between failed connections, in milliseconds */
		retryInterval?: number
	}

	/** auto-discover registered namespaces, and add them to the peer store */
	autoDiscover?: boolean
	/** auto-discovery inverval, in milliseconds */
	autoDiscoverInterval?: number
}

const DEFAULT_TIMEOUT = 1000
const DEFAULT_RETRY_INTERVAL = 10000

/** initiate registration renewal within this margin of expiration */
const TTL_MARGIN = 30

export class RendezvousClient extends TypedEventEmitter<PeerDiscoveryEvents> implements Startable {
	public static protocol = "/canvas/rendezvous/1.0.0"

	private readonly log = logger("canvas:rendezvous:client")
	private readonly peers = new Set<string>()
	private readonly registerIntervals = new Map<string, NodeJS.Timeout>()
	private readonly controller = new AbortController()

	private readonly autoRegisterNamespaces: string[]
	private readonly autoRegisterPeers: Map<string, Multiaddr[]>
	private readonly autoRegisterTTL: number | null
	private readonly autoRegisterInitialTimeout: number
	private readonly autoDiscover: boolean
	private readonly autoDiscoverInterval: number
	private readonly retryInterval: number

	#topologyId: string | null = null
	#started: boolean = false
	#timer: NodeJS.Timeout | null = null

	constructor(
		private readonly components: RendezvousClientComponents,
		init: RendezvousClientInit,
	) {
		super()
		this.autoRegisterNamespaces = init.autoRegister?.namespaces ?? []
		this.autoRegisterPeers = new Map()
		for (const addr of init.autoRegister?.multiaddrs ?? []) {
			const ma = multiaddr(addr)
			const peerId = multiaddr(addr).getPeerId()
			assert(peerId !== null, "invalid bootstrap multiaddr: expected /p2p/... suffix")
			assert(P2P.matches(ma), "invalid bootstrap multiaddr")
			const peer = peerId.toString()
			assert(addr.endsWith(`/p2p/${peer}`), "invalid bootstrap multiaddr")
			const addrs = this.autoRegisterPeers.get(peer)
			if (addrs === undefined) {
				this.autoRegisterPeers.set(peer, [ma])
			} else {
				addrs.push(ma)
			}
		}

		this.autoRegisterTTL = init.autoRegister?.ttl ?? null
		this.autoRegisterInitialTimeout = init.autoRegister?.initialTimeout ?? DEFAULT_TIMEOUT
		this.retryInterval = init.autoRegister?.retryInterval ?? DEFAULT_RETRY_INTERVAL
		this.autoDiscover = init.autoDiscover ?? true
		this.autoDiscoverInterval = init.autoDiscoverInterval ?? Infinity
	}

	readonly [peerDiscoverySymbol] = this

	readonly [serviceCapabilities]: string[] = ["@libp2p/peer-discovery"]

	public isStarted() {
		return this.#started
	}

	public async beforeStart() {
		this.log("beforeStart")

		this.#topologyId = await this.components.registrar.register(RendezvousClient.protocol, {
			onConnect: (peerId, connection) => {
				this.log("connected to %p", peerId)
				const peer = peerId.toString()
				this.peers.add(peer)
				if (this.autoRegisterPeers.has(peer) && !this.registerIntervals.has(peer)) {
					this.registerIntervals.set(
						peer,
						setTimeout(() => this.#register(connection), 0),
					)
				}
			},
			onDisconnect: (peerId) => {
				this.log("disconnected from %p", peerId)
				this.peers.delete(peerId.toString())
			},
		})
	}

	public start() {
		this.log("start")
		this.#started = true
	}

	public afterStart() {
		this.log("afterStart")

		this.log("waiting %s ms before dialing rendezvous servers", this.autoRegisterInitialTimeout)
		this.#timer = setTimeout(() => {
			for (const [peer, addrs] of this.autoRegisterPeers) {
				this.#openConnection(peer).catch((err) => this.log.error("failed to open connection: %O", err))
			}
		}, this.autoRegisterInitialTimeout)
	}

	async #openConnection(peer: string): Promise<Connection> {
		const addrs = this.autoRegisterPeers.get(peer)
		if (addrs === undefined || addrs.length === 0) {
			throw new Error(`missing multiaddrs for peer ${peer}`)
		}

		while (this.#started) {
			try {
				return await this.components.connectionManager.openConnection(addrs, { signal: this.controller.signal })
			} catch (err) {
				this.log.error("failed to connect to peer %s at %o: %O", peer, addrs, err)
				this.log.error("scheduling another connection attempt in %s ms", this.retryInterval)
				await wait(this.retryInterval, { signal: this.controller.signal })
			}
		}

		throw new Error("rendezvous service stopped")
	}

	public beforeStop() {
		this.log("beforeStop")
		clearTimeout(this.#timer ?? undefined)

		this.controller.abort()
		if (this.#topologyId !== null) {
			this.components.registrar.unregister(this.#topologyId)
		}

		for (const intervalId of this.registerIntervals.values()) {
			clearTimeout(intervalId)
		}

		this.registerIntervals.clear()
	}

	public stop() {
		this.log("stop")
		this.#started = false
	}

	public afterStop() {
		this.log("afterStop")
	}

	#schedule(peer: string, interval: number) {
		clearTimeout(this.registerIntervals.get(peer))
		if (this.#started) {
			this.registerIntervals.set(
				peer,
				setTimeout(
					() =>
						this.#openConnection(peer).then(
							(connection) => this.#register(connection),
							(err) => this.log.error("failed to open connection: %O", err),
						),
					interval,
				),
			)
		}
	}

	async #register(connection: Connection) {
		const peerId = connection.remotePeer
		this.log("initiating registration with peer %p", peerId)

		const interval = await this.#connect(connection, async (point) => {
			let interval = this.autoDiscoverInterval

			const multiaddrs = this.components.addressManager.getAnnounceAddrs()
			for (const ns of this.autoRegisterNamespaces) {
				// register
				if (multiaddrs.length > 0) {
					try {
						const { ttl } = await point.register(ns, { multiaddrs, ttl: this.autoRegisterTTL })
						const refreshInterval = Math.max(ttl - TTL_MARGIN, TTL_MARGIN) * 1000
						interval = Math.min(interval, refreshInterval)
						this.log("successfully registered %s with %p (ttl %d)", ns, peerId, ttl)
					} catch (err) {
						this.log.error("failed to register %s with %p: %O", ns, peerId, err)
						interval = Math.min(interval, this.retryInterval)
					}
				} else {
					this.log("skipping registration because no announce addresses were configured")
				}

				// discover
				if (this.autoDiscover) {
					try {
						const results = await point.discover(ns)
						for (const peerData of results) {
							if (peerData.id.equals(this.components.peerId)) {
								continue
							}

							await this.components.peerStore.patch(peerData.id, peerData)
							this.safeDispatchEvent("peer", { detail: peerData })
						}
					} catch (err) {
						this.log.error("failed to discover %s from %p: %O", ns, peerId, err)
					}
				}
			}

			return interval
		})

		if (interval < Infinity) {
			this.log("scheduling next registration in %s ms", interval)
			this.#schedule(peerId.toString(), interval)
		}
	}

	public async connect<T>(
		server: PeerId | Multiaddr | Multiaddr[],
		callback: (point: RendezvousPoint) => T | Promise<T>,
	): Promise<T> {
		assert(this.#started, "service not started")

		const connection = await this.components.connectionManager.openConnection(server)
		this.log("got connection %s to peer %p", connection.id, connection.remotePeer)

		return await this.#connect(connection, callback)
	}

	async #connect<T>(connection: Connection, callback: (point: RendezvousPoint) => T | Promise<T>): Promise<T> {
		const stream = await connection.newStream(RendezvousClient.protocol)
		this.log("opened outgoing rendezvous stream %s", stream.id)

		const source = pushable<Message>({ objectMode: true })
		pipe(source, encodeMessages, lp.encode, stream.sink).catch((err) => {
			this.log.error("error piping requests: %O", err)
			stream.abort(err)
		})

		const sink = pipe(stream.source, lp.decode, decodeMessages)

		try {
			return await callback({
				discover: async (namespace, options = {}) => {
					this.log("discover(%s, %o)", namespace, options)
					source.push({
						type: Message.MessageType.DISCOVER,
						discover: { ns: namespace, limit: BigInt(options.limit ?? 0), cookie: new Uint8Array() },
					})

					const { done, value: res } = await sink.next()
					assert(!done, "stream ended prematurely")

					assert(res.type === Message.MessageType.DISCOVER_RESPONSE, "expected DISCOVER_RESPONSE message")
					assert(res.discoverResponse !== undefined, "invalid DISCOVER_RESPONSE message")

					const { status, statusText, registrations, cookie } = res.discoverResponse
					if (status !== Message.ResponseStatus.OK) {
						this.log.error("error in discover response: %s", statusText)
						throw new Error(status)
					}

					const peers: Peer[] = []

					for (const { ns, signedPeerRecord } of registrations) {
						assert(ns === namespace, "invalid namespace in registration")
						const envelope = await RecordEnvelope.openAndCertify(signedPeerRecord, PeerRecord.DOMAIN)
						const { peerId, multiaddrs } = PeerRecord.createFromProtobuf(envelope.payload)
						assert(peerIdFromPublicKey(envelope.publicKey).equals(peerId), "invalid peer id in registration")

						this.log("discovered %p on %s with addresses %o", peerId, ns, multiaddrs)

						const peer = await this.components.peerStore.merge(peerId, {
							addresses: multiaddrs.map((addr) => ({ multiaddr: addr, isCertified: true })),
							peerRecordEnvelope: signedPeerRecord,
						})

						peers.push(peer)
					}

					return peers
				},
				register: async (namespace, options = {}) => {
					this.log("register(%s, %o)", namespace, options)
					const multiaddrs = options.multiaddrs ?? this.components.addressManager.getAnnounceAddrs()
					const record = new PeerRecord({ peerId: this.components.peerId, multiaddrs })
					const envelope = await RecordEnvelope.seal(record, this.components.privateKey)
					const signedPeerRecord = envelope.marshal()

					this.log("registering multiaddrs %o", multiaddrs)

					source.push({
						type: Message.MessageType.REGISTER,
						register: { ns: namespace, signedPeerRecord, ttl: BigInt(options.ttl ?? 0) },
					})

					const { done, value: res } = await sink.next()

					assert(!done, "stream ended prematurely")
					assert(res.type === Message.MessageType.REGISTER_RESPONSE, "expected REGISTER_RESPONSE message")
					assert(res.registerResponse !== undefined, "invalid REGISTER_RESPONSE message")

					const { status, statusText, ttl } = res.registerResponse
					if (status !== Message.ResponseStatus.OK) {
						this.log.error("error in register response: %s", statusText)
						throw new Error(status)
					}

					return { ttl: Number(ttl) }
				},
				unregister: async (namespace) => {
					this.log("unregister(%s)", namespace)
					source.push({
						type: Message.MessageType.UNREGISTER,
						unregister: { ns: namespace },
					})
				},
			})
		} finally {
			source.end()
			stream.close()
			this.log("closed outgoing rendezvous stream %s", stream.id)
		}
	}
}

export const rendezvousClient =
	(init: RendezvousClientInit = {}) =>
	(components: RendezvousClientComponents) =>
		new RendezvousClient(components, init)
