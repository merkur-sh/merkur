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
