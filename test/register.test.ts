import test from "ava"
import { setTimeout } from "timers/promises"

import { PeerInfo } from "@libp2p/interface"
import { rendezvousServer } from "@canvas-js/libp2p-rendezvous/server"
import { rendezvousClient } from "@canvas-js/libp2p-rendezvous/client"

import { getLibp2p } from "./libp2p.js"

test.serial("manual registration and discovery", async (t) => {
	const server = await getLibp2p(t, { port: 8880 }, { rendezvous: rendezvousServer({}) })
	const clientA = await getLibp2p(t, { name: "client-a", port: 8881 }, { rendezvous: rendezvousClient({}) })
	const clientB = await getLibp2p(t, { name: "client-b", port: 8882 }, { rendezvous: rendezvousClient({}) })

	await setTimeout(100)

	await clientA.services.rendezvous.connect(server.getMultiaddrs(), async (point) => {
		await point.register("foobar")
	})

	await setTimeout(100)

	await clientB.services.rendezvous.connect(server.getMultiaddrs(), async (point) => {
		const results = await point.discover("foobar")
		t.true(results.length === 1)
		t.true(results[0].id.equals(clientA.peerId))
	})

	t.pass()
})

test.serial("auto registration and discovery", async (t) => {
	const server = await getLibp2p(t, { port: 8883 }, { rendezvous: rendezvousServer({}) })
	const multiaddrs = server.getMultiaddrs().map((addr) => addr.toString())

	await setTimeout(200)

	const clientADiscoveryEvents: PeerInfo[] = []
	const clientA = await getLibp2p(
		t,
		{ name: "client-a", port: 8884 },
		{
			rendezvous: rendezvousClient({
				autoRegister: { namespaces: ["foobar"], multiaddrs, initialTimeout: 100 },
				autoDiscover: true,
			}),
		},
	)

	clientA.addEventListener("peer:discovery", ({ detail: peerInfo }) => {
		clientADiscoveryEvents.push(peerInfo)
	})

	const clientBDiscoveryEvents: PeerInfo[] = []
	const clientB = await getLibp2p(
		t,
		{ name: "client-b", port: 8885 },
		{
			rendezvous: rendezvousClient({
				autoRegister: { namespaces: ["foobar"], multiaddrs, initialTimeout: 100 },
				autoDiscover: true,
			}),
		},
	)

	clientB.addEventListener("peer:discovery", ({ detail: peerInfo }) => {
		clientBDiscoveryEvents.push(peerInfo)
	})

	await setTimeout(500)

	const peerInfoToString = ({ id, multiaddrs }: PeerInfo) => {
		return {
			id: id.toString(),
			multiaddrs: multiaddrs.map((addr) => addr.toString()),
		}
	}

	t.deepEqual(clientADiscoveryEvents.map(peerInfoToString), [
		{ id: server.peerId.toString(), multiaddrs: [`/ip4/127.0.0.1/tcp/8883/ws/p2p/${server.peerId}`] },
		{
			id: clientB.peerId.toString(),
			multiaddrs: ["/ip4/127.0.0.1/tcp/8885/ws"],
		},
	])

	t.deepEqual(clientBDiscoveryEvents.map(peerInfoToString), [
		{ id: server.peerId.toString(), multiaddrs: [`/ip4/127.0.0.1/tcp/8883/ws/p2p/${server.peerId}`] },
		{
			id: clientA.peerId.toString(),
			multiaddrs: ["/ip4/127.0.0.1/tcp/8884/ws"],
		},
	])

	// console.log(clientADiscoveryEvents)
	// console.log(clientBDiscoveryEvents)

	t.pass()
})
