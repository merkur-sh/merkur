# The service hosts in deploy/service-hosts.json. The release installs the
# edge and STUN on them over SSH; this file owns the machines, their addresses
# and their firewall.

resource "hcloud_ssh_key" "owner" {
  name       = "merkur-ops"
  public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIEeef2ZWoWpHPfyNKnmcVr5zPzBXXO0NIJ/ITK6j8Kd dmytro.pletenskyi@mika.health"
}

resource "hcloud_firewall" "service_host" {
  name = "merkur-edge"

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
  rule {
    description = "icmp"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "nbg_1" {
  name         = "merkur-edge-1"
  server_type  = "cx23"
  location     = "nbg1"
  image        = "debian-12"
  ssh_keys     = [hcloud_ssh_key.owner.id]
  firewall_ids = [hcloud_firewall.service_host.id]
  labels       = { app = "merkur", role = "edge" }

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
