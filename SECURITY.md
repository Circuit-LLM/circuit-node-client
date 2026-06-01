# Security Policy

## Reporting a Vulnerability

Do **not** open a public GitHub issue for security vulnerabilities.

Email: **security@circuitllm.xyz**

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Your contact info (optional)

We will respond within 48 hours and aim to ship a fix within 7 days of confirmation.

## Sensitive Files

The following files are gitignored and must never be committed:

| File | Contents |
|------|----------|
| `data/identity.json` | Your node's ed25519 private key — permanent identity |
| `data/signing-key.json` | Operator signing key — only on the canonical VPS |
| `config/client.json` | Your local config (may contain API keys if you added them) |
| `.env` | Environment variables |

If you accidentally commit any of these, rotate the key immediately — git history cannot be safely scrubbed.

## Update Integrity

All software updates distributed through the CIRCUIT network are:

- **Signed** with an ed25519 keypair held by the canonical operator
- **Checksummed** with SHA-256

The public signing key is embedded in `config/client.example.json` under `updates.signingPublicKey`. Your node verifies both the signature and checksum before applying any update. Never accept an update that fails verification.

## Scope

The following are in scope for responsible disclosure:

- Authentication or signature bypass in the update system
- Identity or nodeId impersonation
- Unauthorized access to the local API from non-localhost origins
- Phase 3 encryption weaknesses (AES-256-GCM key derivation)
- Registry endpoint vulnerabilities that could affect node reputation scores

The following are out of scope:

- Vulnerabilities in `node_modules` dependencies (report to upstream maintainers)
- Issues requiring physical access to the machine running the node
- Self-inflicted misconfiguration (e.g., binding the local API to a public interface)
