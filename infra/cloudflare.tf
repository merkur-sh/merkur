# The merkur.sh zone. Records start as exact copies of what Namecheap served
# before the nameserver switch, DNS-only, so the switch changes nothing. The
# website and the Rybbit dashboard are proxied through Cloudflare; app.merkur.sh
# never is, so TLS for the app ends on the app host and nowhere else.

resource "cloudflare_zone" "merkur" {
  account = { id = var.cloudflare_account_id }
  name    = "merkur.sh"
  type    = "full"
}

locals {
  zone_id = cloudflare_zone.merkur.id
}

# The website on app-1, through Cloudflare.
resource "cloudflare_dns_record" "apex" {
  zone_id = local.zone_id
  name    = "merkur.sh"
  type    = "A"
  content = hcloud_server.app_1.ipv4_address
  ttl     = 1
  proxied = true
}

resource "cloudflare_dns_record" "www" {
  zone_id = local.zone_id
  name    = "www.merkur.sh"
  type    = "A"
  content = hcloud_server.app_1.ipv4_address
  ttl     = 1
  proxied = true
}

# The application server on app-1, reached directly: TLS ends in its Caddy.
resource "cloudflare_dns_record" "app" {
  zone_id = local.zone_id
  name    = "app.merkur.sh"
  type    = "A"
  content = hcloud_server.app_1.ipv4_address
  ttl     = 1
  proxied = false
}

resource "cloudflare_dns_record" "app_v6" {
  zone_id = local.zone_id
  name    = "app.merkur.sh"
  type    = "AAAA"
  content = hcloud_server.app_1.ipv6_address
  ttl     = 1
  proxied = false
}

# The Rybbit dashboard on analytics-1, through Cloudflare.
resource "cloudflare_dns_record" "analytics" {
  zone_id = local.zone_id
  name    = "analytics.merkur.sh"
  type    = "A"
  content = hcloud_server.analytics_1.ipv4_address
  ttl     = 1
  proxied = true
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

# The proxy serves the bytes the origins send: the site's pages carry a strict
# CSP, so nothing may rewrite a response on the way (email obfuscation, HTTPS
# rewrites, Rocket Loader, server-side excludes), and `curl merkur.sh/install`
# is a program, which a browser challenge would lock out. Cloudflare's DDoS
# mitigation applies whatever the security level.
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

# The website's pages are cached at the edge for as long as the site's own
# `s-maxage` says (an hour); Cloudflare would otherwise cache only its default
# file extensions. Deploy site purges both hosts once the new build serves.
resource "cloudflare_ruleset" "cache" {
  zone_id = local.zone_id
  name    = "cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"
  rules = [{
    description = "cache the website's pages by its own headers"
    expression  = "(http.host in {\"merkur.sh\" \"www.merkur.sh\"})"
    action      = "set_cache_settings"
    action_parameters = {
      cache    = true
      edge_ttl = { mode = "respect_origin" }
    }
  }]
}

data "cloudflare_account_api_token_permission_groups_list" "cache_purge" {
  account_id = var.cloudflare_account_id
  name       = "Cache Purge"
}

# The `site` GitHub environment's SITE_CLOUDFLARE_PURGE_TOKEN: purges this zone's
# cache and can do nothing else.
resource "cloudflare_account_token" "site_purge" {
  account_id = var.cloudflare_account_id
  name       = "merkur-site-purge"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = one(data.cloudflare_account_api_token_permission_groups_list.cache_purge.result).id }]
    resources         = jsonencode({ "com.cloudflare.api.account.zone.${local.zone_id}" = "*" })
  }]
}

output "zone_id" {
  value = local.zone_id
}

output "site_purge_token" {
  value     = cloudflare_account_token.site_purge.value
  sensitive = true
}
