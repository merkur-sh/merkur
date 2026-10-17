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
| `r2-state-access`, `r2-state-secret` | Cloudflare R2 keys for the state bucket alone |
| `cloudflare-api-token` | Cloudflare API token |
| `tofu-state-passphrase` | Encrypts the state and plans |

State lives in the `merkur-infra-state` bucket in Cloudflare R2's EU jurisdiction, locked with
S3 lock files, and encrypted client-side with AES-GCM: the repository is public and state holds
secrets, so state never enters it. Losing the passphrase loses the state, not the
infrastructure; it can be re-imported. The bucket and its key are made by hand (OpenTofu cannot
create the bucket it keeps its own state in); the key is an account token scoped to that bucket,
whose id is the S3 access key and the SHA-256 of whose value is the secret.

`backups.tf` declares the backup bucket the hosts upload to (`deploy/backup`), its 30-day object
lock and 35-day expiry, and the hosts' write-only key. The backups are encrypted to an age key
whose private half is in the owner's Keychain as `merkur-backup-age-identity` and nowhere else;
keep an offline copy beside the release seed's, because without it no backup can be read.

A running server is never rebuilt by a plan: its image, first-boot configuration, initial SSH
keys and primary IPs are creation inputs (`ignore_changes`), because the edge's public URL and
the server's `STUN_SERVERS` name its addresses.
