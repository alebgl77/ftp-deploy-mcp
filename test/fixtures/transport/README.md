These are public, disposable TEST ONLY credentials. Never trust this certificate
or use this private key outside the loopback transport tests.

The RSA 2048-bit key and self-signed SHA-256 certificate were generated specifically
for this fixture using Python cryptography 50.0.1, with no production credentials.
The certificate covers DNS localhost and IP 127.0.0.1, is a test trust anchor with
serverAuth usage, and is valid from 2026-01-01 through 2040-01-01 UTC. The trusted
case adds it only to a child process via NODE_EXTRA_CA_CERTS; the rejection case
uses the same certificate without adding that trust. SFTP client and host keys
are generated afresh at test runtime.

Run `node --test test/transport-qualification.js`. The small FTPS fixture implements
only the commands used by these adapter tests, with real control and data TLS on
loopback ports assigned by the OS. This qualifies local transport behavior, not
interoperability with every FTPS server or TLS session-resumption policy.
