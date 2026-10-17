variable "state_passphrase" {
  description = "Encrypts the state and plans; Keychain service `tofu-state-passphrase`."
  type        = string
  sensitive   = true
}

variable "hcloud_token" {
  description = "Hetzner Cloud API token; Keychain service `hcloud`."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token; Keychain service `cloudflare-api-token`."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "The Cloudflare account holding the merkur.sh zone."
  type        = string
  default     = "562c6d031f1a5828df411c499318392b"
}
