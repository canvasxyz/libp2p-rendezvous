import type { PeerId } from "@libp2p/interface"
import { PeerRecord, RecordEnvelope } from "@libp2p/peer-record"
import { logger } from "@libp2p/logger"
import { Multiaddr } from "@multiformats/multiaddr"

import Database, * as sqlite from "better-sqlite3"

import { assert } from "./utils.js"

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
		{ after: bigint; namespace: string; expiration: bigint; limit: bigint },
		{ id: bigint; peer: string; signed_peer_record: Uint8Array; expiration: bigint }
	>
	#selectAll: sqlite.Statement<
		{ after: bigint },
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
			  WHERE id > :after AND namespace = :namespace AND expiration > :expiration
				ORDER BY id DESC LIMIT :limit`,
		)

		this.#selectAll = this.db.prepare(
			`SELECT id, peer, namespace, expiration FROM registrations
			  WHERE id > :after
				ORDER BY id ASC`,
		)
	}

	public async *iterate(
		after: bigint = 0n,
	): AsyncIterable<{ id: bigint; peerId: PeerId; namespace: string; multiaddrs: Multiaddr[]; expiration: bigint }> {
		for (const { id, namespace, signed_peer_record, expiration } of this.#selectAll.iterate({ after })) {
			const envelope = await RecordEnvelope.createFromProtobuf(signed_peer_record)
			const { peerId, multiaddrs } = PeerRecord.createFromProtobuf(envelope.payload)
			yield { id, peerId, namespace, multiaddrs, expiration }
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

	public discover(namespace: string, limit: bigint, cookie: Uint8Array | null): DiscoverResult {
		let after = 0n
		if (cookie !== null) {
			const { buffer, byteOffset, byteLength } = cookie
			assert(byteLength === 8, "invalid cookie")
			after = new DataView(buffer, byteOffset, byteLength).getBigUint64(0)
		}

		const expiration = now()
		const results = this.#discover.all({ after, namespace, expiration, limit })

		let lastId = 0n
		if (results.length > 0) {
			lastId = results[results.length - 1].id
		}

		const cookieBuffer = new ArrayBuffer(8)
		new DataView(cookieBuffer).setBigUint64(0, lastId)

		return {
			cookie: new Uint8Array(cookieBuffer),
			registrations: results.map((result) => ({
				ns: namespace,
				signedPeerRecord: result.signed_peer_record,
				ttl: result.expiration - expiration,
			})),
		}
	}

	public gc() {
		this.#gc.run({ expiration: now() })
	}

	public close() {
		clearInterval(this.#interval)
		this.db.close()
	}
}
