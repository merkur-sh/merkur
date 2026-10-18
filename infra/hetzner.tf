# The hosts in deploy/service-hosts.json. One host, nbg-1, runs every role
# today: the edge and STUN, the application server with its database and the
# website, and Rybbit. The manifest assigns each role to a host, so a role
# moves to a host of its own by adding the host here and there. The release
# installs the software over SSH; this file owns the machines, their addresses
# and their firewall.

resource "hcloud_ssh_key" "owner" {
  name       = "merkur-ops"
  public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIEeef2ZWoWpHPfyNKnmcVr5zPzBXXO0NIJ/ITK6j8Kd dmytro.pletenskyi@mika.health"
}

resource "hcloud_firewall" "service_host" {
  name = "merkur-nbg-1"

  rule {
    description = "ssh (key only)"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "edge webtransport"
    direction   = "in"
    protocol    = "udp"
    port        = "4433"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "stun observers + change port"
    direction   = "in"
    protocol    = "udp"
    port        = "3478-3481"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  # The development loop's own edge and STUN responder, which a checkout's
  # server registers and tickets with dev-only keys (dev.merkur.sh).
  rule {
    description = "dev edge webtransport"
    direction   = "in"
    protocol    = "udp"
    port        = "4434"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "dev stun observers + change port"
    direction   = "in"
    protocol    = "udp"
    port        = "3488-3491"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  # The app answers everyone directly; Caddy answers the website's and the
  # dashboard's names only for Cloudflare (deploy/caddy).
  rule {
    description = "http, for the redirect and ACME"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "https"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
  rule {
    description = "icmp"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "nbg_1" {
  name        = "merkur-nbg-1"
  server_type = "cx33"
  location    = "nbg1"
  image       = "debian-12"
  backups     = true
  # The disk stays at the smaller type's size, so the host can move down again.
  keep_disk    = true
  ssh_keys     = [hcloud_ssh_key.owner.id]
  firewall_ids = [hcloud_firewall.service_host.id]
  labels       = { app = "merkur" }

  # The primary IPs the manifest and the server's STUN_SERVERS name.
  public_net {
    ipv4_enabled = true
    ipv4         = 156125064
    ipv6_enabled = true
    ipv6         = 156125065
  }

  # Creation inputs: a running host is provisioned by the release, so changing
  # these must never plan a rebuild that would change its addresses.
  lifecycle {
    ignore_changes = [image, user_data, ssh_keys, public_net]
  }
}

# The STUN responder's second IPv4. A daemon proves its NAT's mapping
# endpoint-independent only from two observer addresses, and the TFTP admission
# offers its candidate only when both agree; a server holds one primary IPv4, so
# the second is a floating address the merkur-stun-addrs unit configures.
resource "hcloud_floating_ip" "nbg_1_stun" {
  name          = "merkur-edge-1-stun"
  type          = "ipv4"
  home_location = "nbg1"
  server_id     = hcloud_server.nbg_1.id
  labels        = { app = "merkur", role = "stun" }
}

import {
  to = hcloud_ssh_key.owner
  id = "131434366"
}

import {
  to = hcloud_firewall.service_host
  id = "11822903"
}

import {
  to = hcloud_server.nbg_1
  id = "170938264"
}

import {
  to = hcloud_floating_ip.nbg_1_stun
  id = "156239915"
}
