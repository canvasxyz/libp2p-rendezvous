# libp2p-rendezvous

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg)](https://github.com/RichardLitt/standard-readme) [![license](https://img.shields.io/github/license/canvasxyz/libp2p-rendezvous)](https://opensource.org/licenses/MIT) [![NPM version](https://img.shields.io/npm/v/@canvas-js/libp2p-rendezvous)](https://www.npmjs.com/package/@canvas-js/libp2p-rendezvous) ![TypeScript types](https://img.shields.io/npm/types/@canvas-js/libp2p-rendezvous)

JavaScript implementation of the libp2p [rendezvous protocol](https://github.com/libp2p/specs/tree/master/rendezvous).

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
  - [`@canvas-js/libp2p-rendezvous/client`](#canvas-js-libp2p-rendezvous-client)
  - [`@canvas-js/libp2p-rendezvous/server`](#canvas-js-libp2p-rendezvous-server)
- [Testing](#testing)
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

Add the rendezvous client service to the peers that need to find each other:

```ts
import { rendezvousClient } from "@canvas-js/libp2-rendezvous/client"

const libp2p = await createLibp2p({
  // ...
  services: {
    // ...
    rendezvous: rendezvousClient({
      autoRegister: {
        namespaces: ["topic-a", "topic-b"],
        multiaddrs: ["/dns4/my-rendezvous-server/..."],
      },
      autoDiscover: true,
    }),
  },
})
```

Providing namespaces and multiaddrs to `autoRegister` will cause the client to automatically dial those servers on startup, effectively replacing the `@libp2p/bootstrap` service.

The client service will then register each namespaces with all of the peers that support the rendezvous server protocol, track the returned TTLs, and automatically renew the registrations shortly before expiration, re-connecting to each peer if necessary.

The `autoDiscovery` feature is enabled by default, which will query for other peers registered under each of the provided namespaces, and emit the results as peer discovery events.

Alternatively, you can choose to manually connect to a server and make `register`, `unregister`, and `discover` calls yourself:

```ts
const serverPeerId = peerIdFromString("...")
await libp2p.services.rendezvous.connect(serverPeerId, async (point) => {
  await point.register("topic-a")
  await point.unregister("topic-b")
  const peers = await point.discover("topic-c")
  // peers: { id: PeerId; addresses: { multiaddr: Multiaddr }[]; ... }[]
})
```

## API

### `@canvas-js/libp2p-rendezvous/client`

```ts
import type { TypedEventTarget, Libp2pEvents, PeerId, PeerStore, Peer, Connection } from "@libp2p/interface"
import type { Registrar, AddressManager, ConnectionManager } from "@libp2p/interface-internal"
import type { Multiaddr } from "@multiformats/multiaddr"

export interface RendezvousPoint {
  discover(namespace: string, options?: { limit?: number }): Promise<Peer[]>
  register(namespace: string, options?: { ttl?: number | null; multiaddrs?: Multiaddr[] }): Promise<{ ttl: number }>
  unregister(namespace: string): Promise<void>
}

export type RendezvousClientComponents = {
  /** internal libp2p components */
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

export declare class RendezvousClient {
  public static protocol = "/canvas/rendezvous/1.0.0"

  public connect<T>(
    server: PeerId | Multiaddr | Multiaddr[],
    callback: (point: RendezvousPoint) => T | Promise<T>,
  ): Promise<T>
}

export declare const rendezvousClient: (
  init?: RendezvousClientInit,
) => (components: RendezvousClientComponents) => RendezvousClient
```

### `@canvas-js/libp2p-rendezvous/server`

```ts
import { TypedEventTarget, Libp2pEvents, PeerId, PeerStore } from "@libp2p/interface"
import { Registrar, AddressManager, ConnectionManager } from "@libp2p/interface-internal"

export type RendezvousServerComponents = {
  /** internal libp2p components */
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

## Testing

Tests use [AVA](https://github.com/avajs/ava) and live in the [test](https://github.com/canvas-js/libp2p-rendezvous/blob/main/test) directory.

```
npm run test
```

## Contributing

Open an issue if you have questions, find bugs, or have interface suggestions. Only minor PRs will be considered without prior discussion.

## License

MIT © Canvas Technologies, Inc.
