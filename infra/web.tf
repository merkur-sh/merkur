# TLS for the names behind Cloudflare (the website and the Rybbit dashboard),
# and the Cloudflare ranges Caddy answers them for. app.merkur.sh is reached
# directly, so no third party decrypts the app's traffic: Caddy holds its Let's
# Encrypt certificate.

data "cloudflare_ip_ranges" "cloudflare" {}

# Cloudflare-to-origin TLS for exactly the proxied names: a wildcard would also
# match app.merkur.sh, which Caddy would then serve with this certificate, which
# browsers do not trust. The key exists only in the encrypted state and on the
# hosts; `scripts/tofu.sh output -raw origin_tls_key` hands it to provisioning.
locals {
  proxied_names = ["merkur.sh", "www.merkur.sh", "analytics.merkur.sh"]
}

resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  subject {
    common_name = "merkur.sh"
  }
  dns_names = local.proxied_names
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = sort(local.proxied_names)
  request_type       = "origin-ecc"
  requested_validity = 5475
}

output "origin_tls_certificate" {
  value = cloudflare_origin_ca_certificate.origin.certificate
}

output "origin_tls_key" {
  value     = tls_private_key.origin.private_key_pem
  sensitive = true
}

# Caddy's CLOUDFLARE_RANGES on every web host (deploy/app/app.caddy,
# deploy/analytics/analytics.caddy): the only peers the proxied names answer, and
# the proxies whose X-Forwarded-For Caddy extends.
output "cloudflare_ranges" {
  value = join(" ", concat(data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs, data.cloudflare_ip_ranges.cloudflare.ipv6_cidrs))
}
