# libp2p-rendezvous

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg)](https://github.com/RichardLitt/standard-readme) [![license](https://img.shields.io/github/license/canvasxyz/libp2p-rendezvous)](https://opensource.org/licenses/MIT) [![NPM version](https://img.shields.io/npm/v/@canvas-js/libp2p-rendezvous)](https://www.npmjs.com/package/@canvas-js/libp2p-rendezvous) ![TypeScript types](https://img.shields.io/npm/types/@canvas-js/libp2p-rendezvous)

JavaScript implementation of the libp2p [rendezvous protocol](https://github.com/libp2p/specs/tree/master/rendezvous).

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Contributing](#contributing)
- [License](#license)

## Install

```
npm i @canvas-js/libp2p-rendezvous
```

## Usage

Rendezvous servers maintain a SQLite database of "registrations", consisting of a string namespace and a signed peer record. Rendezvous clients can _register_ and _unregister_ themselves for arbitrary namespaces, and _discover_ other peer registrations by namespace.

### Server

Add the rendezvous server service to a public libp2p peer:

```ts
import { rendezvousServer } from "@canvas-js/libp2p-rendezvous/server"

const libp2p = await createLibp2p({
  // ...
  services: {
    // ...
    rendezvous: rendezvousServer({ path: "rendezvous-registrations.sqlite" }),
  },
})
```

The `path` is optional; an in-memory SQLite database will be used if it is `null` or not provided.

### Client

Then add the rendezvous client service to the peers that need to find each other:

```ts
import { bootstrap } from "@libp2p/bootstrap"
import { rendezvousClient } from "@canvas-js/libp2-rendezvous/client"

const libp2p = await createLibp2p({
  // ...
  peerDiscovery: [bootstrap(["/dns4/my-rendezvous-server/..."])]
  services: {
    // ...
    rendezvous: rendezvousClient({
      autoRegister: ["topic-a", "topic-b"],
      autoDiscover: true,
    })
  },
})
```

Providing namespaces to `autoRegister` and enabling `autoDiscovery` will cause the client to automatically register those namespaces with every rendezvous server it connects to (ie every peer supporting the rendezvous protocol), and automatically renew its regsitrations when they expire, re-connecting to the server if necessary.

Alternatively, you can choose to manually connect to a server and make `register`, `unregister`, and `discover` calls yourself:

```ts
const serverPeerId = peerIdFromString("...")
await libp2p.services.rendezvous.connect(serverPeerId, async (point) => {
  await point.register("topic-a")
  await point.unregister("topic-b")
  const peers = await point.discover("topic-c")
  // peers discovered manually are not automatically added to the peerStore
})
```

## API

```ts
// @canvas-js/libp2p-rendezvous/client

import type { TypedEventTarget, Libp2pEvents, PeerId, PeerStore, Peer, Connection } from "@libp2p/interface"
import type { Registrar, AddressManager, ConnectionManager } from "@libp2p/interface-internal"
import type { Multiaddr } from "@multiformats/multiaddr"

export interface RendezvousPoint {
  discover(namespace: string, options?: { limit?: number }): Promise<Peer[]>
  register(namespace: string, options?: { ttl?: number }): Promise<{ ttl: number }>
  unregister(namespace: string): Promise<void>
}

export type RendezvousClientComponents = {
  events: TypedEventTarget<Libp2pEvents>
  peerId: PeerId
  peerStore: PeerStore
  registrar: Registrar
  addressManager: AddressManager
  connectionManager: ConnectionManager
}

export interface RendezvousClientInit {
  /**
   * namespace or array of namespaces to register automatically
   * with all peers that support the rendezvous server protocol
   */
  autoRegister?: string[] | null
  autoDiscover?: boolean
  connectionFilter?: (connection: Connection) => boolean
}

export declare class RendezvousClient {
  public static protocol = "/canvas/rendezvous/1.0.0"

  public constructor(components: RendezvousClientComponents, init: RendezvousClientInit)

  public connect<T>(
    server: PeerId | Multiaddr | Multiaddr[],
    callback: (point: RendezvousPoint) => T | Promise<T>,
  ): Promise<T>
}

export declare const rendezvousClient: (
  init?: RendezvousClientInit,
) => (components: RendezvousClientComponents) => RendezvousClient
```

```ts
// @canvas-js/libp2p-rendezvous/server

import { TypedEventTarget, Libp2pEvents, PeerId, PeerStore } from "@libp2p/interface"
import { Registrar, AddressManager, ConnectionManager } from "@libp2p/interface-internal"

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
}

export declare class RendezvousServer implements Startable {
  public static protocol = "/canvas/rendezvous/1.0.0"

  public constructor(components: RendezvousServerComponents, init: RendezvousServerInit)
}

export declare const rendezvousServer: (
  init?: RendezvousServerInit,
) => (components: RendezvousServerComponents) => RendezvousServer
```

## Contributing

Open an issue if you have questions, find bugs, or have interface suggestions. Only minor PRs will be considered without prior discussion.

## License

MIT © Canvas Technologies, Inc.
