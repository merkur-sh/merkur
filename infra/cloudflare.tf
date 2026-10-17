# The merkur.sh zone. Records start as exact copies of what Namecheap served
# before the nameserver switch, DNS-only, so the switch changes nothing; a
# service is proxied through Cloudflare when it moves behind it.

resource "cloudflare_zone" "merkur" {
  account = { id = var.cloudflare_account_id }
  name    = "merkur.sh"
  type    = "full"
}

locals {
  zone_id = cloudflare_zone.merkur.id
}

# The website (Railway service `site`).
resource "cloudflare_dns_record" "apex" {
  zone_id = local.zone_id
  name    = "merkur.sh"
  type    = "CNAME"
  content = "r1nd4wcc.up.railway.app"
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "www" {
  zone_id = local.zone_id
  name    = "www.merkur.sh"
  type    = "CNAME"
  content = "2hpd8m07.up.railway.app"
  ttl     = 1
  proxied = false
}

# The application server (Railway service `mercury`).
resource "cloudflare_dns_record" "app" {
  zone_id = local.zone_id
  name    = "app.merkur.sh"
  type    = "CNAME"
  content = "7qs1larj.up.railway.app"
  ttl     = 1
  proxied = false
}

# Outbound mail through Resend.
resource "cloudflare_dns_record" "send" {
  zone_id = local.zone_id
  name    = "send.merkur.sh"
  type    = "CNAME"
  content = "send.forge.rmta.net"
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "dkim" {
  zone_id = local.zone_id
  name    = "resend._domainkey.merkur.sh"
  type    = "TXT"
  content = "\"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDL2udKwPEO52KR0pkXubRcITJw0DnlRGIw5m1Q6XOCUfLo56VrRXgQPvvukvQD8ZCSDZw4J8iRC7gwC7s5KXffKpMsKyjkseJK8e0QPRMk/CYVwALpS07rOsgKm5hzJotBpEJXJyHSSnePjxzkpWMfAGu+QPYhYBdZGsBBmQDfDwIDAQAB\""
  ttl     = 1
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = local.zone_id
  name    = "_dmarc.merkur.sh"
  type    = "TXT"
  content = "\"v=DMARC1; p=none;\""
  ttl     = 1
}

# The proxy serves the bytes the origins send. The app's web bundle is signed and its
# pages carry a strict CSP, so nothing may rewrite a response on the way (email
# obfuscation, HTTPS rewrites, Rocket Loader, server-side excludes), and the daemon,
# the edges and the installer are programs, which a browser challenge would lock
# out. Cloudflare's DDoS mitigation applies whatever the security level.
locals {
  zone_settings = {
    ssl                      = "strict"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
    always_use_https         = "on"
    automatic_https_rewrites = "off"
    email_obfuscation        = "off"
    rocket_loader            = "off"
    server_side_exclude      = "off"
    browser_check            = "off"
    security_level           = "essentially_off"
    always_online            = "off"
    "0rtt"                   = "off"
  }
}

resource "cloudflare_zone_setting" "merkur" {
  for_each   = local.zone_settings
  zone_id    = local.zone_id
  setting_id = each.key
  value      = each.value
}
