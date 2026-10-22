// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The egress policy for a Worker's own network requests: global `fetch()`
//! and `new WebSocket()`.
//!
//! On Cloudflare those requests leave from the edge onto the public internet,
//! so a Worker can never reach a private, loopback, link-local or metadata
//! address, whatever its flags say. A celld node runs inside an operator's
//! network instead, so it refuses those addresses itself: a Worker can reach a
//! non-public address only when the operator names its `host:port` in
//! `CELLD_FETCH_PRIVATE_ALLOW`.
//!
//! The check is on the address celld actually connects to. An IP literal is
//! checked before the request and at every redirect hop; a name is checked
//! inside the resolver, which hands the connector only the addresses that
//! passed. A name that resolves differently a second time (DNS rebinding)
//! therefore cannot pass the check with one address and connect to another.
//!
//! Service bindings, `ctx.exports`, Durable Object stubs and a container's
//! `getTcpPort()` are bindings, not network requests, and `connect()` from
//! `cloudflare:sockets` is the operator-network tool: none of them is checked
//! here.

use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::sync::OnceLock;

/// One `CELLD_FETCH_PRIVATE_ALLOW` entry: a host and the one port it allows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowEntry {
    pub host: AllowHost,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AllowHost {
    /// An address. It matches however the URL reached it, as written or
    /// through a name, because the entry names what celld connects to.
    Ip(IpAddr),
    /// A lower-case DNS name without a trailing dot. It matches a URL whose
    /// host is that name, and then every address the name resolves to.
    Name(String),
}

/// Why the policy refused a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    /// The `host:port` the Worker asked for, as the URL spells it.
    authority: String,
    reason: Reason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    /// Not a public address, and not allowed by `CELLD_FETCH_PRIVATE_ALLOW`.
    NotPublic,
    /// A connection outside a request this module checked. No Worker request
    /// reaches this: it keeps an unchecked connection from passing silently.
    Unchecked,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let authority = &self.authority;
        match self.reason {
            Reason::NotPublic => write!(
                formatter,
                "celld egress policy: {authority} is not a public address, so this node \
                 refuses to connect to it. A node operator can allow it by adding \
                 {authority} to CELLD_FETCH_PRIVATE_ALLOW."
            ),
            Reason::Unchecked => write!(
                formatter,
                "celld egress policy: the connection to {authority} was not checked, so this \
                 node refuses it"
            ),
        }
    }
}

impl std::error::Error for Refused {}

/// The refusal behind a failed outbound request, if the policy caused it.
pub fn refusal<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<&'a Refused> {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(refused) = error.downcast_ref::<Refused>() {
            return Some(refused);
        }
        source = error.source();
    }
    None
}

/// Why `ip` is not a public address, or `None` when it is one.
///
/// The table is IANA's special-purpose registries, taken whole where a range
/// mixes reachable and unreachable addresses: celld refuses what Cloudflare's
/// network could not reach. An IPv6 address that embeds an IPv4 one
/// (IPv4-mapped, NAT64 `64:ff9b::/96`, 6to4) is judged by the IPv4 address,
/// which is where it leads.
pub fn non_public(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(ip) => non_public_v4(ip),
        IpAddr::V6(ip) => match embedded_v4(ip) {
            Some(ip) => non_public_v4(ip),
            None => non_public_v6(ip),
        },
    }
}

const V4_RANGES: &[(Ipv4Addr, u8, &str)] = &[
    (Ipv4Addr::new(0, 0, 0, 0), 8, "unspecified"),
    (Ipv4Addr::new(10, 0, 0, 0), 8, "private"),
    (Ipv4Addr::new(100, 64, 0, 0), 10, "shared (CGNAT)"),
    (Ipv4Addr::new(127, 0, 0, 0), 8, "loopback"),
    (Ipv4Addr::new(169, 254, 0, 0), 16, "link-local"),
    (Ipv4Addr::new(172, 16, 0, 0), 12, "private"),
    (Ipv4Addr::new(192, 0, 0, 0), 24, "IETF protocol assignment"),
    (Ipv4Addr::new(192, 0, 2, 0), 24, "documentation"),
    (Ipv4Addr::new(192, 88, 99, 0), 24, "6to4 relay anycast"),
    (Ipv4Addr::new(192, 168, 0, 0), 16, "private"),
    (Ipv4Addr::new(198, 18, 0, 0), 15, "benchmarking"),
    (Ipv4Addr::new(198, 51, 100, 0), 24, "documentation"),
    (Ipv4Addr::new(203, 0, 113, 0), 24, "documentation"),
    (Ipv4Addr::new(224, 0, 0, 0), 4, "multicast"),
    (Ipv4Addr::new(240, 0, 0, 0), 4, "reserved"),
];

const V6_RANGES: &[(Ipv6Addr, u8, &str)] = &[
    (Ipv6Addr::UNSPECIFIED, 128, "unspecified"),
    (Ipv6Addr::LOCALHOST, 128, "loopback"),
    // The deprecated IPv4-compatible form, `::a.b.c.d`.
    (Ipv6Addr::UNSPECIFIED, 96, "IPv4-compatible"),
    (
        Ipv6Addr::new(0, 0, 0, 0, 0xffff, 0, 0, 0),
        96,
        "IPv4-translated",
    ),
    (
        Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0),
        48,
        "local-use NAT64",
    ),
    (
        Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0),
        64,
        "discard-only",
    ),
    // Includes Teredo, whose embedded addresses are obfuscated.
    (
        Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0),
        23,
        "IETF protocol assignment",
    ),
    (
        Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0),
        32,
        "documentation",
    ),
    (
        Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0),
        20,
        "documentation",
    ),
    (
        Ipv6Addr::new(0x5f00, 0, 0, 0, 0, 0, 0, 0),
        16,
        "segment routing",
    ),
    (
        Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0),
        7,
        "unique local",
    ),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10, "link-local"),
    (Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10, "site-local"),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8, "multicast"),
];

fn non_public_v4(ip: Ipv4Addr) -> Option<&'static str> {
    let bits = u32::from(ip);
    V4_RANGES.iter().find_map(|&(network, prefix, reason)| {
        let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
        (bits & mask == u32::from(network)).then_some(reason)
    })
}

fn non_public_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let bits = u128::from(ip);
    V6_RANGES.iter().find_map(|&(network, prefix, reason)| {
        let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
        (bits & mask == u128::from(network)).then_some(reason)
    })
}

/// The IPv4 address an IPv6 one leads to: IPv4-mapped (`::ffff:a.b.c.d`),
/// well-known NAT64 (`64:ff9b::a.b.c.d`) and 6to4 (`2002:aabb:ccdd::/48`).
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return Some(mapped);
    }
    let bits = u128::from(ip);
    if bits >> 32 == u128::from(Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0)) >> 32 {
        return Some(Ipv4Addr::from(bits as u32));
    }
    if bits >> 112 == 0x2002 {
        return Some(Ipv4Addr::from((bits >> 80) as u32));
    }
    None
}

/// An address as the policy compares it: an IPv4-mapped IPv6 address is the
/// IPv4 address, so `[::ffff:10.0.0.1]` cannot slip past a `10.0.0.1` rule or
/// fail to match a `10.0.0.1` entry.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

/// The node's policy: the operator's allowlist.
#[derive(Debug)]
struct Policy {
    allow: Vec<AllowEntry>,
}

impl Policy {
    fn new(allow: Vec<AllowEntry>) -> Self {
        Self {
            allow: allow
                .into_iter()
                .map(|entry| AllowEntry {
                    host: match entry.host {
                        AllowHost::Ip(ip) => AllowHost::Ip(canonical(ip)),
                        name => name,
                    },
                    port: entry.port,
                })
                .collect(),
        }
    }

    /// Whether a Worker may connect to `ip:port`, reached through the URL
    /// host `host` (lower-case, without brackets).
    fn permits(&self, host: &str, ip: IpAddr, port: u16) -> bool {
        let ip = canonical(ip);
        if non_public(ip).is_none() {
            return true;
        }
        self.allow.iter().any(|entry| {
            entry.port == port
                && match &entry.host {
                    AllowHost::Ip(allowed) => *allowed == ip,
                    AllowHost::Name(name) => name == normalized_name(host),
                }
        })
    }
}

/// A host as allowlist entries spell names: lower-case, no trailing dot.
fn normalized_name(host: &str) -> &str {
    host.strip_suffix('.').unwrap_or(host)
}

/// The node's policy, from `CELLD_FETCH_PRIVATE_ALLOW`. Every celld command
/// validates the variable at startup (`env_vars::validate`), so an invalid
/// value never reaches a serving node; a library caller that skipped that
/// gets an empty allowlist, the policy's most restrictive form.
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let allow = crate::env_vars::fetch_private_allow().unwrap_or_else(|error| {
            tracing::error!(%error, "Worker egress allows no private address");
            &[]
        });
        Policy::new(allow.to_vec())
    })
}

/// Where one hop of a request goes: the URL's host and port.
#[derive(Clone, Debug)]
struct Destination {
    /// The host without brackets, as the resolver receives it.
    host: String,
    /// An IP literal host, which no resolver sees.
    literal: Option<IpAddr>,
    port: u16,
    /// `host:port` as the URL spells it, for messages.
    authority: String,
}

impl Destination {
    fn of(url: &url::Url) -> Result<Self, String> {
        let port = url
            .port_or_known_default()
            .ok_or_else(|| format!("{url} has no port"))?;
        let (host, literal) = match url.host() {
            Some(url::Host::Domain(name)) => (name.to_string(), None),
            Some(url::Host::Ipv4(ip)) => (ip.to_string(), Some(IpAddr::V4(ip))),
            Some(url::Host::Ipv6(ip)) => (ip.to_string(), Some(IpAddr::V6(ip))),
            None => return Err(format!("{url} has no host")),
        };
        let authority = format!("{}:{port}", url.host_str().unwrap_or_default());
        Ok(Self {
            host,
            literal,
            port,
            authority,
        })
    }

    fn refused(&self, reason: Reason) -> Refused {
        Refused {
            authority: self.authority.clone(),
            reason,
        }
    }

    /// Check an IP literal, which connects without the resolver.
    fn check_literal(&self, exempt: Option<SocketAddr>) -> Result<(), Refused> {
        let Some(ip) = self.literal else {
            return Ok(());
        };
        check_address(self, ip, exempt)
    }
}

/// The check for one address of one destination.
fn check_address(
    destination: &Destination,
    ip: IpAddr,
    exempt: Option<SocketAddr>,
) -> Result<(), Refused> {
    if exempt.is_some_and(|exempt| {
        canonical(exempt.ip()) == canonical(ip) && exempt.port() == destination.port
    }) {
        return Ok(());
    }
    if policy().permits(&destination.host, ip, destination.port) {
        return Ok(());
    }
    Err(destination.refused(Reason::NotPublic))
}

/// The addresses of `destination` the policy lets a Worker connect to, in
/// resolver order; the refusal when there are none.
///
/// A name never gets a binding's exempt address. The exemption is for the one
/// literal address the host looked up; a name's connection goes into the
/// client's shared pool under that name, where a later Worker request that
/// asked for no exemption would reuse it unchecked.
async fn resolve(
    destination: &Destination,
) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    let addresses = tokio::net::lookup_host((destination.host.as_str(), destination.port)).await?;
    let mut refused = None;
    let allowed: Vec<SocketAddr> = addresses
        .filter(
            |address| match check_address(destination, address.ip(), None) {
                Ok(()) => true,
                Err(refusal) => {
                    refused.get_or_insert(refusal);
                    false
                }
            },
        )
        .collect();
    match refused {
        Some(refused) if allowed.is_empty() => Err(Box::new(refused)),
        _ => Ok(allowed),
    }
}

/// The request one `fetch()` is making: where its current hop goes, and the
/// container address its binding may reach as an IP literal.
struct Checked {
    hop: Mutex<Destination>,
    exempt: Option<SocketAddr>,
}

tokio::task_local! {
    /// The request whose future is being polled. The resolver and the redirect
    /// policy run inside that poll, so this is how they learn the port and the
    /// hop. A connection started outside it finds nothing and is refused.
    static CHECKED: Checked;
}

/// A request checked before it is sent. `exempt` is the container address a
/// `getTcpPort()` fetch may reach, as that IP literal only, and nothing else.
pub(crate) struct Request {
    destination: Destination,
    exempt: Option<SocketAddr>,
}

impl Request {
    /// Check the first hop of a request to `url`. An IP literal is checked
    /// here; a name is checked when the resolver answers.
    pub(crate) fn check(url: &str, exempt: Option<SocketAddr>) -> Result<Self, CheckError> {
        let parsed =
            url::Url::parse(url).map_err(|error| CheckError::Invalid(format!("{url}: {error}")))?;
        let destination = Destination::of(&parsed).map_err(CheckError::Invalid)?;
        destination
            .check_literal(exempt)
            .map_err(CheckError::Refused)?;
        Ok(Self {
            destination,
            exempt,
        })
    }

    /// Run `send`, the request's future, with this request's checks in force
    /// for every connection and redirect it makes.
    pub(crate) async fn send<F: std::future::Future>(self, send: F) -> F::Output {
        CHECKED
            .scope(
                Checked {
                    hop: Mutex::new(self.destination),
                    exempt: self.exempt,
                },
                send,
            )
            .await
    }
}

pub(crate) enum CheckError {
    Invalid(String),
    Refused(Refused),
}

/// Follow a redirect that the request's redirect mode allows, if the next hop
/// passes the policy. Every redirect policy of a client from [`client`] that
/// follows must follow through this.
pub(crate) fn follow(attempt: reqwest::redirect::Attempt) -> reqwest::redirect::Action {
    match check_hop(attempt.url()) {
        Ok(()) => attempt.follow(),
        Err(error) => attempt.error(error),
    }
}

/// Check a redirect's next hop, and make it the hop the resolver checks.
fn check_hop(url: &url::Url) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let hop = Destination::of(url)?;
    CHECKED
        .try_with(|checked| {
            hop.check_literal(checked.exempt)?;
            *checked.hop.lock().unwrap() = hop.clone();
            Ok(())
        })
        .unwrap_or_else(|_| Err(hop.refused(Reason::Unchecked)))?;
    Ok(())
}

/// Resolves only within a checked request, to the addresses that pass.
struct Resolver;

impl reqwest::dns::Resolve for Resolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        // Read now: the connector calls this while the request is polled.
        let checked = CHECKED.try_with(|checked| checked.hop.lock().unwrap().clone());
        let name = name.as_str().to_string();
        Box::pin(async move {
            let hop = match checked {
                Ok(hop) if hop.host.eq_ignore_ascii_case(&name) => hop,
                _ => {
                    return Err(Box::new(Refused {
                        authority: name,
                        reason: Reason::Unchecked,
                    })
                        as Box<dyn std::error::Error + Send + Sync>)
                }
            };
            let addresses = resolve(&hop).await?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// A client for Worker egress, to send through [`Request::send`]. It resolves
/// through the policy and ignores the proxy environment variables: a proxy
/// would connect on the Worker's behalf to an address no check saw. A
/// `redirect` policy that follows must follow through [`follow`], because an
/// IP literal in a `Location` reaches no resolver.
pub(crate) fn client(redirect: reqwest::redirect::Policy) -> reqwest::Client {
    reqwest::Client::builder()
        .dns_resolver(std::sync::Arc::new(Resolver))
        .no_proxy()
        .redirect(redirect)
        .build()
        .expect("build the Worker egress HTTP client")
}

/// Open a TCP connection for a Worker's outbound WebSocket to `url`, to an
/// address that passes the policy.
pub(crate) async fn connect(
    url: &url::Url,
    exempt: Option<SocketAddr>,
) -> Result<tokio::net::TcpStream, ConnectError> {
    let destination =
        Destination::of(url).map_err(|error| ConnectError::Io(std::io::Error::other(error)))?;
    let addresses = match destination.literal {
        Some(ip) => {
            check_address(&destination, ip, exempt).map_err(ConnectError::Refused)?;
            vec![SocketAddr::new(ip, destination.port)]
        }
        None => resolve(&destination)
            .await
            .map_err(|error| match error.downcast::<Refused>() {
                Ok(refused) => ConnectError::Refused(*refused),
                Err(error) => ConnectError::Io(std::io::Error::other(error)),
            })?,
    };
    let mut last = None;
    for address in addresses {
        match tokio::net::TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(ConnectError::Io(last.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} resolved to no address", destination.authority),
        )
    })))
}

pub(crate) enum ConnectError {
    Refused(Refused),
    Io(std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn the_range_table_refuses_every_listed_range() {
        for (address, reason) in [
            ("0.0.0.0", "unspecified"),
            ("0.1.2.3", "unspecified"),
            ("10.0.0.1", "private"),
            ("10.255.255.255", "private"),
            ("100.64.0.1", "shared (CGNAT)"),
            ("100.127.255.255", "shared (CGNAT)"),
            ("127.0.0.1", "loopback"),
            ("127.8.9.10", "loopback"),
            ("169.254.169.254", "link-local"),
            ("172.16.0.1", "private"),
            ("172.31.255.255", "private"),
            ("192.0.0.170", "IETF protocol assignment"),
            ("192.0.2.1", "documentation"),
            ("192.168.1.1", "private"),
            ("198.18.0.1", "benchmarking"),
            ("198.19.255.255", "benchmarking"),
            ("224.0.0.1", "multicast"),
            ("239.255.255.250", "multicast"),
            ("240.0.0.1", "reserved"),
            ("255.255.255.255", "reserved"),
            ("::", "unspecified"),
            ("::1", "loopback"),
            ("::a00:1", "IPv4-compatible"),
            ("::ffff:0:a00:1", "IPv4-translated"),
            ("64:ff9b:1::1", "local-use NAT64"),
            ("100::1", "discard-only"),
            ("2001::1", "IETF protocol assignment"),
            ("2001:db8::1", "documentation"),
            ("3fff::1", "documentation"),
            ("5f00::1", "segment routing"),
            ("fc00::1", "unique local"),
            ("fd12:3456::1", "unique local"),
            ("fe80::1", "link-local"),
            ("fec0::1", "site-local"),
            ("ff02::1", "multicast"),
        ] {
            assert_eq!(non_public(ip(address)), Some(reason), "{address}");
        }
    }

    #[test]
    fn an_embedded_ipv4_address_is_judged_by_where_it_leads() {
        for (address, reason) in [
            ("::ffff:127.0.0.1", Some("loopback")),
            ("::ffff:10.1.2.3", Some("private")),
            ("::ffff:169.254.169.254", Some("link-local")),
            ("::ffff:1.1.1.1", None),
            ("64:ff9b::7f00:1", Some("loopback")),
            ("64:ff9b::a9fe:a9fe", Some("link-local")),
            ("64:ff9b::c0a8:101", Some("private")),
            ("64:ff9b::101:101", None),
            ("2002:7f00:1::1", Some("loopback")),
            ("2002:a00:1::", Some("private")),
            ("2002:101:101::1", None),
        ] {
            assert_eq!(non_public(ip(address)), reason, "{address}");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "9.255.255.255",
            "11.0.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.167.255.255",
            "192.169.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.255",
            "2606:4700:4700::1111",
            "2a00:1450:4001::200e",
            "2001:200::1",
        ] {
            assert_eq!(non_public(ip(address)), None, "{address}");
        }
    }

    fn entry(host: AllowHost, port: u16) -> AllowEntry {
        AllowEntry { host, port }
    }

    #[test]
    fn an_entry_allows_its_host_on_its_port_only() {
        let policy = Policy::new(vec![
            entry(AllowHost::Ip(ip("127.0.0.1")), 11434),
            entry(AllowHost::Ip(ip("::ffff:10.0.0.5")), 8080),
            entry(AllowHost::Name("models.internal".into()), 443),
        ]);
        // An IP entry, however the URL reached the address.
        assert!(policy.permits("127.0.0.1", ip("127.0.0.1"), 11434));
        assert!(policy.permits("localhost", ip("127.0.0.1"), 11434));
        assert!(policy.permits("::ffff:7f00:1", ip("::ffff:127.0.0.1"), 11434));
        assert!(!policy.permits("127.0.0.1", ip("127.0.0.1"), 11435));
        assert!(!policy.permits("127.0.0.2", ip("127.0.0.2"), 11434));
        assert!(!policy.permits("::1", ip("::1"), 11434));
        // A mapped entry is its IPv4 address.
        assert!(policy.permits("10.0.0.5", ip("10.0.0.5"), 8080));
        // A name entry, by the URL's host, on every address it resolves to.
        assert!(policy.permits("models.internal", ip("10.9.9.9"), 443));
        assert!(policy.permits("models.internal.", ip("fd00::9"), 443));
        assert!(!policy.permits("models.internal", ip("10.9.9.9"), 80));
        assert!(!policy.permits("other.internal", ip("10.9.9.9"), 443));
        assert!(!policy.permits("10.9.9.9", ip("10.9.9.9"), 443));
        // A public address needs no entry.
        assert!(policy.permits("example.com", ip("93.184.215.14"), 22));
    }

    fn destination(url: &str) -> Destination {
        Destination::of(&url::Url::parse(url).unwrap()).unwrap()
    }

    #[test]
    fn a_literal_is_refused_in_every_spelling() {
        for (url, authority) in [
            ("http://127.0.0.1/", "127.0.0.1:80"),
            ("https://2130706433/", "127.0.0.1:443"),
            ("http://0x7f.1:8080/", "127.0.0.1:8080"),
            ("http://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]:80"),
            ("ws://[64:ff9b::a9fe:a9fe]/", "[64:ff9b::a9fe:a9fe]:80"),
        ] {
            let refused = destination(url).check_literal(None).unwrap_err();
            assert_eq!(refused.authority, authority, "{url}");
            assert_eq!(refused.reason, Reason::NotPublic, "{url}");
        }
        assert!(destination("http://1.1.1.1/").check_literal(None).is_ok());
        // A name is the resolver's to check.
        assert!(destination("http://localhost/").check_literal(None).is_ok());
    }

    #[test]
    fn the_exempt_address_is_the_only_one_a_binding_adds() {
        let container: SocketAddr = "172.17.0.2:8080".parse().unwrap();
        assert!(destination("http://172.17.0.2:8080/")
            .check_literal(Some(container))
            .is_ok());
        assert!(destination("http://172.17.0.2:8081/")
            .check_literal(Some(container))
            .is_err());
        assert!(destination("http://172.17.0.3:8080/")
            .check_literal(Some(container))
            .is_err());
    }

    #[test]
    fn the_refusal_names_the_policy_and_the_escape_hatch() {
        let refused = destination("http://10.0.0.1:9000/")
            .check_literal(None)
            .unwrap_err();
        let message = refused.to_string();
        assert!(
            message.starts_with("celld egress policy: 10.0.0.1:9000 "),
            "{message}"
        );
        assert!(message.contains("CELLD_FETCH_PRIVATE_ALLOW"), "{message}");
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(refused.clone());
        assert_eq!(refusal(boxed.as_ref()), Some(&refused));
    }

    #[test]
    fn the_exempt_address_holds_for_literal_hops_and_never_for_names() {
        crate::asyncrt::test_host_runtime().block_on(async {
            // A container port on loopback, so `localhost` resolves to it.
            let container: SocketAddr = "127.0.0.1:9".parse().unwrap();
            let request = Request::check("http://127.0.0.1:9/", Some(container))
                .ok()
                .unwrap();
            let (back, other, name) = request
                .send(async {
                    let back = check_hop(&url::Url::parse("http://127.0.0.1:9/b").unwrap());
                    let other = check_hop(&url::Url::parse("http://127.0.0.1:10/").unwrap());
                    // A redirect to a name that resolves to the container's
                    // address: its connection would join the shared pool
                    // under the name, so the resolver refuses it.
                    let name =
                        check_hop(&url::Url::parse("http://localhost:9/").unwrap()).map(|_| ());
                    let resolved =
                        reqwest::dns::Resolve::resolve(&Resolver, "localhost".parse().unwrap())
                            .await;
                    (back, other, name.and(resolved.map(|_| ())))
                })
                .await;
            assert!(back.is_ok());
            let other = other.unwrap_err();
            assert_eq!(refusal(other.as_ref()).unwrap().reason, Reason::NotPublic);
            let name = name.unwrap_err();
            let refused = refusal(name.as_ref()).unwrap();
            assert_eq!(refused.reason, Reason::NotPublic);
            assert_eq!(refused.authority, "localhost:9");
        });
    }

    #[test]
    fn a_hop_outside_a_checked_request_is_refused() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let resolving = reqwest::dns::Resolve::resolve(&Resolver, "localhost".parse().unwrap());
            let error = match resolving.await {
                Ok(_) => panic!("an unchecked name resolved"),
                Err(error) => error,
            };
            assert_eq!(
                refusal(error.as_ref()).map(|refused| refused.reason),
                Some(Reason::Unchecked)
            );
        });
    }

    #[test]
    fn a_name_resolves_only_to_the_addresses_that_pass() {
        crate::asyncrt::test_host_runtime().block_on(async {
            let request = Request::check("http://localhost:9/", None).ok().unwrap();
            // Called inside the request's poll, as the connector calls it.
            let resolved = request
                .send(async {
                    reqwest::dns::Resolve::resolve(&Resolver, "localhost".parse().unwrap()).await
                })
                .await;
            let error = match resolved {
                Ok(_) => panic!("localhost passed the policy"),
                Err(error) => error,
            };
            let refused = refusal(error.as_ref()).unwrap();
            assert_eq!(refused.reason, Reason::NotPublic);
            assert_eq!(refused.authority, "localhost:9");
        });
    }
}
