# Admin UI

Headscale serves a web interface at `/admin/`, for example
`https://headscale.example.com/admin/`. It is a single-page app embedded in the
`headscale` binary and uses the same [HTTP API](api.md) as the command line, so
there is nothing else to install or run.

## Sign in

Create an API key and paste it on the sign-in page:

```sh
headscale apikeys create
```

The key is kept in the browser's local storage. **Sign out** removes it. An API
key has full admin access, so serve the UI over HTTPS (see
[reverse proxy](integration/reverse-proxy.md)) and give each person their own key.

The policy editor saves through the API, which needs `policy.mode: database` in the
[configuration](configuration.md). With `policy.mode: file` the editor can read and
simulate but not save.

## What it does

| Page | |
| --- | --- |
| **Machines** | Every machine with its status, owner, addresses, tags, routes and traffic. A machine's page has copy buttons for its IPs and MagicDNS name, its OS and client version, what it can reach and who can reach it, route approval, recent activity, and rename, tag, key expiry and delete. **Add device** makes an auth key with ready-to-paste commands, or approves an interactive login. |
| **Network** | A map of what the stored policy allows, or, with the Traffic switch, the real traffic reported by the [flow agent](flow-agent.md). |
| **Activity** | The event log: machines coming and going, registrations, expiry, renames, tag and route changes, policy updates, user and key changes. |
| **Policy** | A visual editor for grants, ACL rules, groups, tags and hosts, and a code editor. Visual edits change only what you touch, so comments and layout stay; you can add a note to any rule, group, tag or host and it is saved as a `//` comment. See below. |
| **Users** | Create, rename and delete users. |
| **Keys** | Auth keys (to join machines), API keys (for tools and this UI) and agent keys (to let flow agents report traffic and nothing else). |
| **Settings** | The server version and login URL, and the DNS settings. DNS is read-only here: edit the `dns:` section of `config.yaml` and restart. |

## Testing a policy

While you edit, the **Playground** answers "may A reach B on this port" for the
draft, using the packet filter headscale would send to the destination, so the
answer is the same as the network's. The **Access matrix** shows every pair, and a
click on a cell loads it into the playground. Pin a flow as **Must allow** or
**Must deny** to turn it into a scenario that is checked again on every edit, so a
change that would break access you rely on is flagged before you save.

Only network access (ACLs and grants) is simulated, not Tailscale SSH rules.

An empty policy allows everything; an empty `acls` or `grants` list denies
everything. The editor says which of the two you have.

## Building

The UI lives in `ui/` and is compiled into the binary:

```sh
cd ui && npm install && npm run build
cd .. && go build ./cmd/headscale
```

A checkout without a UI build still compiles; `/admin/` is then empty. See
`ui/README.md` for development, and `ui/e2e` for the browser tests.
