# Infrastructure

OpenTofu declares Merkur's Hetzner hosts and its Cloudflare zone. The release installs
software on the hosts (`deploy/service-hosts.json`); this directory owns the machines, their
addresses and firewalls, and the `merkur.sh` DNS records.

```sh
bash scripts/tofu.sh init
bash scripts/tofu.sh plan
bash scripts/tofu.sh apply
```

`scripts/tofu.sh` reads every credential from the macOS Keychain (account `merkur`):

| Keychain service | What |
| --- | --- |
| `hcloud` | Hetzner Cloud API token |
| `hcloud-s3-access`, `hcloud-s3-secret` | Hetzner Object Storage keys for the state bucket |
| `cloudflare-api-token` | Cloudflare API token |
| `tofu-state-passphrase` | Encrypts the state and plans |

State lives in the `merkur-infra-state` bucket in Hetzner Object Storage (`nbg1`), versioned,
locked with S3 lock files, and encrypted client-side with AES-GCM: the repository is public and
state holds secrets, so state never enters it. Losing the passphrase loses the state, not the
infrastructure; it can be re-imported.

A running server is never rebuilt by a plan: its image, first-boot configuration, initial SSH
keys and primary IPs are creation inputs (`ignore_changes`), because the edge's public URL and
the server's `STUN_SERVERS` name its addresses.
