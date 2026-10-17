# The hosts behind Cloudflare: app-1 runs the application server, its database
# (sqld), Dragonfly and the website; analytics-1 runs Rybbit. Each terminates
# TLS in Caddy with a Cloudflare Origin CA certificate and accepts HTTP(S) only
# from Cloudflare, so every request has passed Cloudflare's proxy first.

data "cloudflare_ip_ranges" "cloudflare" {}

resource "hcloud_firewall" "web_host" {
  name = "merkur-web"

  rule {
    description = "ssh (key only)"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "https from cloudflare"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = concat(data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs, data.cloudflare_ip_ranges.cloudflare.ipv6_cidrs)
  }
  rule {
    description = "icmp"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

locals {
  # First boot only: the container runtime, the TLS proxy and unattended
  # security updates. Everything above that is installed by the deploy.
  web_host_user_data = <<-CLOUD
    #cloud-config
    package_update: true
    packages: [docker.io, docker-cli, docker-compose, caddy, unattended-upgrades, apparmor]
    ssh_pwauth: false
    runcmd:
      - systemctl enable --now docker
  CLOUD
}

resource "hcloud_server" "app_1" {
  name         = "merkur-app-1"
  server_type  = "cx23"
  location     = "nbg1"
  image        = "debian-13"
  backups      = true
  ssh_keys     = [hcloud_ssh_key.owner.id]
  firewall_ids = [hcloud_firewall.web_host.id]
  labels       = { app = "merkur", role = "app" }
  user_data    = local.web_host_user_data

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    ignore_changes = [image, user_data, ssh_keys, public_net]
  }
}

resource "hcloud_server" "analytics_1" {
  name         = "merkur-analytics-1"
  server_type  = "cx33"
  location     = "nbg1"
  image        = "debian-13"
  backups      = true
  ssh_keys     = [hcloud_ssh_key.owner.id]
  firewall_ids = [hcloud_firewall.web_host.id]
  labels       = { app = "merkur", role = "analytics" }
  user_data    = local.web_host_user_data

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    ignore_changes = [image, user_data, ssh_keys, public_net]
  }
}

# Cloudflare-to-origin TLS. The key exists only in the encrypted state and on
# the hosts; `scripts/tofu.sh output -raw origin_tls_key` hands it to the
# provisioning step.
resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  subject {
    common_name = "merkur.sh"
  }
  dns_names = ["merkur.sh", "*.merkur.sh"]
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = ["merkur.sh", "*.merkur.sh"]
  request_type       = "origin-ecc"
  requested_validity = 5475
}

output "app_1_ipv4" {
  value = hcloud_server.app_1.ipv4_address
}

output "analytics_1_ipv4" {
  value = hcloud_server.analytics_1.ipv4_address
}

output "origin_tls_certificate" {
  value = cloudflare_origin_ca_certificate.origin.certificate
}

output "origin_tls_key" {
  value     = tls_private_key.origin.private_key_pem
  sensitive = true
}
