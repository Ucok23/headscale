# Flow agent

The admin UI can show what traffic actually flows between your machines, not only
what the policy allows. Headscale cannot see that traffic itself: machines talk to
each other directly over WireGuard and nothing passes through the server. So a
small program, `hs-flow-agent`, runs on each machine, reads the kernel's
connection table, and reports what it sees.

The agent is optional. Machines, users, keys, the activity log, the policy editor
and the policy simulator work without it. Without it the **Network** page shows
what the policy allows, and the traffic view stays empty.

## What it reports

Every 15 seconds the agent sends, for each connection between two tailnet
addresses, how many bytes and packets moved since the last report, plus the
Tailscale client's own byte counters (`tailscale metrics print`). It does not read
packet contents, and it ignores traffic that is not between tailnet addresses.

When both ends of a connection run the agent, the connection is counted once.
Connections that are already open when the agent starts are not charged to the
first interval, so a long-lived transfer does not show up as a spike.

## Requirements

- Linux with connection tracking (`nf_conntrack`). It is loaded whenever the
  firewall tracks connections; the agent reads `/proc/net/nf_conntrack`.
- Root, because that file is root-only.
- Byte counts need conntrack accounting:

  ```sh
  sudo sysctl -w net.netfilter.nf_conntrack_acct=1
  echo 'net.netfilter.nf_conntrack_acct = 1' | sudo tee /etc/sysctl.d/90-conntrack-acct.conf
  ```

  Without it the agent still counts connections but warns that bytes are missing.

!!! note "Userspace networking"

    A node running `tailscaled --tun=userspace-networking` has no kernel
    connection table, so the agent has nothing to read there. Its client byte
    counters are still reported.

## Create a key for the agents

Do not give the agents an admin API key. An API key can do anything, and the
agents run on many machines. Use an OAuth client limited to the `flows` scope: it
can report traffic and nothing else (it is refused for the policy, machines and key
management).

In the admin UI open **Keys → Agent keys → Create agent key**, or use the CLI:

```sh
headscale oauth-clients create --scope flows
```

The secret (`hskey-client-…`) is shown once. One key can serve every machine, or
create one per machine to revoke them separately.

## Install

Build the agent with `go build ./cmd/hs-flow-agent` and copy it to each machine.
Then store the key so only root can read it:

```sh
sudo install -d -m 700 /etc/hs-flow-agent
echo 'hskey-client-…' | sudo install -m 600 /dev/stdin /etc/hs-flow-agent/key
```

Try it by hand first:

```sh
sudo hs-flow-agent --server https://headscale.example.com --key-file /etc/hs-flow-agent/key
```

To keep it running, use the systemd unit from `packaging/systemd/hs-flow-agent.service`.
Edit `--server` to your headscale URL, then:

```sh
sudo install -m 755 hs-flow-agent /usr/bin/
sudo install -m 644 hs-flow-agent.service /etc/systemd/system/
sudo systemctl enable --now hs-flow-agent
```

The unit passes the key with `LoadCredential`, so the process receives it from
systemd and the file stays root-only.

## Options

| Flag | Meaning |
| --- | --- |
| `--server` | Headscale URL. |
| `--key-file` | File holding the credential. A warning is printed if other users can read it. |
| `--key` | The credential itself. Avoid it: flags are visible in `ps`. `HEADSCALE_KEY` works too. |
| `--interval` | How often to report (default `15s`). |
| `--self` | This node's tailnet IP (default: `tailscale ip -4`). |
| `--prefix` | Tailnet prefix to keep (repeatable). Default `100.64.0.0/10` and `fd7a:115c:a1e0::/48`. |
| `--tailscale`, `--tailscale-socket` | The Tailscale CLI and socket, for the client byte counters. |
| `--no-metrics` | Do not report client byte counters. |
| `--source` | Connection table to read (default `/proc/net/nf_conntrack`). |
| `--once` | Take two samples one interval apart, print the report, and exit without uploading. |

If you changed the IP prefixes in `config.yaml`, pass the same ones with `--prefix`.

## How it authenticates

An OAuth client secret is exchanged for a one-hour token at
`/api/v2/oauth/token`; the agent refreshes it before it expires and reports to
`POST /api/v2/tailnet/-/flows`, which requires the `flows` scope. An admin API key
(`hskey-api-…`) also works, against `POST /api/v1/flows`, but the agent warns
that it is all-access.

Reports are validated: at most 5000 flows each, with a timestamp no more than an
hour old and no more than five minutes ahead of the server's clock.

## Retention

Flow records are kept for 7 days and events for 30 days, in `activity.db` next to
the main database.
