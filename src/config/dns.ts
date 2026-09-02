import dns from 'node:dns'

const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1']

/**
 * Repairs Node's DNS resolver when it has no usable server.
 *
 * Node resolves SRV and TXT records with its bundled c-ares resolver, not the
 * operating system's. On some Windows setups c-ares cannot read the adapter's
 * DNS configuration and falls back to 127.0.0.1, where nothing is listening.
 * Ordinary hostname lookups still work (those use getaddrinfo), so the machine
 * looks healthy — but `mongodb+srv://` needs SRV and TXT records, so Mongoose
 * fails with `querySrv ECONNREFUSED` against a perfectly good cluster.
 *
 * The check is deliberately narrow: it only acts when every configured server
 * is loopback, which is never a working configuration for public DNS. On a
 * normally configured machine, and on Render, this is a no-op.
 */
export function ensureDnsResolvers(): void {
  const servers = dns.getServers()
  const allLoopback =
    servers.length === 0 || servers.every((server) => server === '127.0.0.1' || server === '::1')

  if (!allLoopback) {
    return
  }

  dns.setServers(PUBLIC_RESOLVERS)
  console.warn(
    `[dns] resolver was ${JSON.stringify(servers)} with nothing listening; ` +
      `switched to ${PUBLIC_RESOLVERS.join(', ')} so mongodb+srv:// lookups work`,
  )
}
