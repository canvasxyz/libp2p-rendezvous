import type { PeerId } from "@libp2p/interface"
import { logger } from "@libp2p/logger"
import { Multiaddr } from "@multiformats/multiaddr"

import Database, * as sqlite from "better-sqlite3"

import { assert, decodePeerRecord } from "./utils.js"
import { peerIdFromString } from "@libp2p/peer-id"

const now = () => BigInt(Math.ceil(Date.now() / 1000))

export type DiscoverResult = {
	cookie: Uint8Array
	registrations: { ns: string; signedPeerRecord: Uint8Array; ttl: bigint }[]
}

export class RegistrationStore {
	private readonly db: sqlite.Database
	private readonly log = logger(`canvas:rendezvous:store`)

	#interval = setInterval(() => this.gc(), 5 * 1000)

	#gc: sqlite.Statement<{ expiration: bigint }>
	#register: sqlite.Statement<{ peer: string; namespace: string; signed_peer_record: Uint8Array; expiration: bigint }>
	#unregister: sqlite.Statement<{ peer: string; namespace: string }>
	#discover: sqlite.Statement<
		{ cursor: bigint; namespace: string; expiration: bigint },
		{ id: bigint; peer: string; signed_peer_record: Uint8Array; expiration: bigint }
	>
	#select: sqlite.Statement<
		{ cursor: bigint; namespace: string },
		{ id: bigint; peer: string; signed_peer_record: Uint8Array; expiration: bigint }
	>
	#selectAll: sqlite.Statement<
		{ cursor: bigint },
		{ id: bigint; peer: string; namespace: string; signed_peer_record: Uint8Array; expiration: bigint }
	>

	constructor(path: string | null = null) {
		if (path !== null) {
			this.log("opening database at %s", path)
		} else {
			this.log("opening in-memory database")
		}

		this.db = new Database(path ?? ":memory:")
		this.db.defaultSafeIntegers(true)
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS registrations (
  		  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  			peer TEXT NOT NULL,
  			namespace TEXT NOT NULL,
        signed_peer_record BLOB NOT NULL,
  			expiration INTEGER NOT NULL
  		)`,
		)

		this.db.exec(`CREATE INDEX IF NOT EXISTS expirations ON registrations(expiration)`)
		this.db.exec(`CREATE INDEX IF NOT EXISTS namespaces ON registrations(namespace, peer)`)
		this.db.exec(`CREATE INDEX IF NOT EXISTS peers ON registrations(peer, namespace)`)

		this.#gc = this.db.prepare(`DELETE FROM registrations WHERE expiration < :expiration`)

		this.#register = this.db.prepare(
			`INSERT INTO registrations(peer, namespace, signed_peer_record, expiration)
			  VALUES (:peer, :namespace, :signed_peer_record, :expiration)`,
		)

		this.#unregister = this.db.prepare(`DELETE FROM registrations WHERE peer = :peer AND namespace = :namespace`)

		this.#discover = this.db.prepare(
			`SELECT id, peer, signed_peer_record, expiration FROM registrations
			  WHERE id > :cursor AND namespace = :namespace AND expiration > :expiration
				ORDER BY id DESC`,
		)

		this.#select = this.db.prepare(
			`SELECT id, peer, signed_peer_record, expiration FROM registrations
			  WHERE id > :cursor AND namespace = :namespace
				ORDER BY id ASC`,
		)

		this.#selectAll = this.db.prepare(
			`SELECT id, peer, signed_peer_record, expiration, namespace FROM registrations
			  WHERE id > :cursor
				ORDER BY id ASC`,
		)
	}

	public async *iterate(
		options: { cursor?: bigint; namespace?: string } = {},
	): AsyncIterable<{ id: bigint; peerId: PeerId; multiaddrs: Multiaddr[]; expiration: bigint; namespace: string }> {
		const { cursor = 0n, namespace = null } = options
		if (namespace === null) {
			for (const { id, peer, signed_peer_record, expiration, namespace } of this.#selectAll.iterate({ cursor })) {
				const { peerId, multiaddrs } = decodePeerRecord(signed_peer_record)
				assert(peerId.toString() === peer, "invalid peer record - expected peerId.toString() === peer")
				yield { id, peerId, multiaddrs, expiration, namespace }
			}
		} else {
			for (const { id, peer, signed_peer_record, expiration } of this.#select.iterate({ cursor, namespace })) {
				const { peerId, multiaddrs } = decodePeerRecord(signed_peer_record)
				assert(peerId.toString() === peer, "invalid peer record - expected peerId.toString() === peer")
				yield { id, peerId, multiaddrs, expiration, namespace }
			}
		}
	}

	public register(namespace: string, peerId: PeerId, signedPeerRecord: Uint8Array, ttl: bigint) {
		this.log.trace("register(%s, %p)", namespace, peerId)
		const expiration = now() + ttl
		this.#unregister.run({ peer: peerId.toString(), namespace })
		this.#register.run({
			peer: peerId.toString(),
			namespace,
			signed_peer_record: signedPeerRecord,
			expiration,
		})
	}

	public unregister(namespace: string, peerId: PeerId) {
		this.log.trace("unregister(%s, %p)", namespace, peerId)
		this.#unregister.run({ peer: peerId.toString(), namespace })
	}

	public discover(
		namespace: string,
		limit: bigint,
		cookie: Uint8Array | null,
		filter?: (namespace: string, peerId: PeerId, multiaddrs: Multiaddr[]) => boolean,
	): DiscoverResult {
		let cursor = 0n
		if (cookie !== null) {
			assert(cookie.byteLength === 8, "invalid cookie")
			const view = new DataView(cookie.buffer, cookie.byteOffset, cookie.byteLength)
			cursor = view.getBigUint64(0)
		}

		const registrations: { ns: string; signedPeerRecord: Uint8Array; ttl: bigint }[] = []
		const expiration = now()
		let lastId = cursor
		for (const result of this.#discover.iterate({ cursor, namespace, expiration })) {
			if (filter !== undefined) {
				const peerRecord = decodePeerRecord(result.signed_peer_record)
				if (!filter(namespace, peerRecord.peerId, peerRecord.multiaddrs)) {
					continue
				}
			}

			const length = registrations.push({
				ns: namespace,
				signedPeerRecord: result.signed_peer_record,
				ttl: result.expiration - expiration,
			})

			lastId = result.id

			if (length >= Number(limit)) {
				break
			}
		}

		const cookieBuffer = new ArrayBuffer(8)
		new DataView(cookieBuffer).setBigUint64(0, lastId)
		return { cookie: new Uint8Array(cookieBuffer), registrations }
	}

	public gc() {
		this.#gc.run({ expiration: now() })
	}

	public close() {
		clearInterval(this.#interval)
		this.db.close()
	}
}
