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
//! checked before the request; a name is checked inside the resolver, which
//! hands the connector only the addresses that passed. The client never
//! follows a redirect: the harness sends each hop as a request of its own, so
//! each one is checked in full. A name that resolves differently a second time (DNS rebinding)
//! therefore cannot pass the check with one address and connect to another.
//!
//! The node's own internal listener and advertise address are refused to
//! every Worker, even when the allowlist names them: they carry the operator
//! routes, which have no authentication of their own.
//!
//! Service bindings, `ctx.exports`, Durable Object stubs and a container's
//! `getTcpPort()` are bindings, not network requests, so nothing here checks
//! them. `connect()` from `cloudflare:sockets` is the operator-network tool:
//! it reaches any address, public or private, except the node's own
//! internal listener and advertise address ([`connect_socket`]).

use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
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
    /// The node's internal listener or advertise address.
    Node,
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
            Reason::Node => write!(
                formatter,
                "celld egress policy: {authority} is this node's internal listener, which \
                 no Worker can reach, even when CELLD_FETCH_PRIVATE_ALLOW names it."
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

/// The node's internal listener and the address it advertises to peers. The
/// operator routes behind them are unauthenticated, so no Worker may reach
/// them, whatever the allowlist says.
#[derive(Debug)]
struct NodeAddresses {
    internal: SocketAddr,
    advertise: crate::startup::Advertise,
}

impl NodeAddresses {
    /// Whether a connection to `ip:port`, reached through the URL host
    /// `host`, would land on one of these addresses.
    fn reached(&self, host: &str, ip: IpAddr, port: u16) -> bool {
        if port == self.internal.port() && lands_on(self.internal.ip(), ip) {
            return true;
        }
        match &self.advertise {
            crate::startup::Advertise::Addr(advertise) => {
                port == advertise.port() && lands_on(advertise.ip(), ip)
            }
            crate::startup::Advertise::Name { .. } => self.advertises(host, port),
        }
    }

    /// Whether `host:port` is the advertised name. celld does not resolve
    /// that name (each peer does), so it matches the name as the URL spells
    /// it; an address the name leads to on this host is refused as the
    /// internal listener's.
    fn advertises(&self, host: &str, port: u16) -> bool {
        match &self.advertise {
            crate::startup::Advertise::Name {
                host: advertised,
                port: advertised_port,
            } => {
                port == *advertised_port
                    && normalized_name(&advertised.to_ascii_lowercase()) == normalized_name(host)
            }
            crate::startup::Advertise::Addr(_) => false,
        }
    }
}

/// Whether a connection to `destination` reaches a socket bound to `bound`.
/// A socket bound to the unspecified address takes every address of this
/// host, and a connection to the unspecified address goes to this host.
fn lands_on(bound: IpAddr, destination: IpAddr) -> bool {
    let (bound, destination) = (canonical(bound), canonical(destination));
    if bound == destination || destination.is_unspecified() {
        return true;
    }
    bound.is_unspecified() && (destination.is_loopback() || is_local_address(destination))
}

/// Whether `ip` is an address of one of this host's interfaces. Read at
/// connect time, so an address added after startup counts too. A failure to
/// read the interfaces counts as local: the check refuses rather than guess.
fn is_local_address(ip: IpAddr) -> bool {
    let ip = canonical(ip);
    match interface_addresses() {
        Ok(addresses) => addresses
            .into_iter()
            .any(|address| canonical(address) == ip),
        Err(error) => {
            tracing::warn!(%error, "could not list the host's interface addresses");
            true
        }
    }
}

/// Every IPv4 and IPv6 address of this host's interfaces, from
/// `getifaddrs(3)`.
#[cfg(unix)]
fn interface_addresses() -> std::io::Result<Vec<IpAddr>> {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: on success getifaddrs points `head` at a list it allocated,
    // which `freeifaddrs` below releases exactly once.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut addresses = Vec::new();
    let mut cursor = head;
    while !cursor.is_null() {
        // SAFETY: `cursor` is a node of the list, which stays allocated until
        // `freeifaddrs`; `ifa_addr` is null or points at a sockaddr whose
        // family field says which sockaddr type it is.
        unsafe {
            let entry = &*cursor;
            if !entry.ifa_addr.is_null() {
                match i32::from((*entry.ifa_addr).sa_family) {
                    libc::AF_INET => {
                        let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
                        addresses.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(
                            address.sin_addr.s_addr,
                        ))));
                    }
                    libc::AF_INET6 => {
                        let address = &*(entry.ifa_addr as *const libc::sockaddr_in6);
                        addresses.push(IpAddr::V6(Ipv6Addr::from(address.sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            cursor = entry.ifa_next;
        }
    }
    // SAFETY: `head` came from the successful getifaddrs above.
    unsafe { libc::freeifaddrs(head) };
    Ok(addresses)
}

#[cfg(not(unix))]
fn interface_addresses() -> std::io::Result<Vec<IpAddr>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "listing interface addresses needs getifaddrs",
    ))
}

static NODE: OnceLock<NodeAddresses> = OnceLock::new();

/// Refuse the node's own internal listener and advertise address to every
/// Worker. The node calls this once, with the bound listener, before it
/// starts the runtime; a process that never serves (a CLI command, a unit
/// test) has no such address.
pub fn install_node_addresses(
    internal: SocketAddr,
    advertise: crate::startup::Advertise,
) -> anyhow::Result<()> {
    let node = NodeAddresses {
        internal,
        advertise,
    };
    // Validation is startup's (`env_vars::validate`); this only warns.
    for entry in crate::env_vars::fetch_private_allow().unwrap_or_default() {
        let named = match &entry.host {
            AllowHost::Ip(ip) => node.reached(&ip.to_string(), *ip, entry.port),
            AllowHost::Name(name) => node.advertises(name, entry.port),
        };
        if named {
            tracing::warn!(
                entry = %format_entry(entry),
                "CELLD_FETCH_PRIVATE_ALLOW names this node's internal listener; no Worker can \
                 reach it"
            );
        }
    }
    NODE.set(node)
        .map_err(|_| anyhow::anyhow!("the node's egress addresses are already installed"))
}

fn format_entry(entry: &AllowEntry) -> String {
    match &entry.host {
        AllowHost::Ip(IpAddr::V6(ip)) => format!("[{ip}]:{}", entry.port),
        AllowHost::Ip(ip) => format!("{ip}:{}", entry.port),
        AllowHost::Name(name) => format!("{name}:{}", entry.port),
    }
}

/// The verdict on one address: the node's own addresses first, which nothing
/// lets past, then a binding's exempt address, then the allowlist.
fn verdict(
    policy: &Policy,
    node: Option<&NodeAddresses>,
    host: &str,
    ip: IpAddr,
    port: u16,
    exempt: Option<SocketAddr>,
) -> Result<(), Reason> {
    if node.is_some_and(|node| node.reached(host, ip, port)) {
        return Err(Reason::Node);
    }
    if exempt.is_some_and(|exempt| canonical(exempt.ip()) == canonical(ip) && exempt.port() == port)
    {
        return Ok(());
    }
    if policy.permits(host, ip, port) {
        return Ok(());
    }
    Err(Reason::NotPublic)
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
    verdict(
        policy(),
        NODE.get(),
        &destination.host,
        ip,
        destination.port,
        exempt,
    )
    .map_err(|reason| destination.refused(reason))
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
                    // The node's own address is the one worth naming: no
                    // allowlist entry would let it through.
                    if refused
                        .as_ref()
                        .is_none_or(|refused: &Refused| refused.reason != Reason::Node)
                    {
                        refused = Some(refusal);
                    }
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

/// The request one `fetch()` hop is making: where it goes.
struct Checked {
    hop: Destination,
}

tokio::task_local! {
    /// The request whose future is being polled. The resolver runs inside
    /// that poll, so this is how it learns the port and the host. A
    /// connection started outside it finds nothing and is refused.
    static CHECKED: Checked;
}

/// A request checked before it is sent. `exempt` is the container address a
/// `getTcpPort()` fetch may reach, as that IP literal only, and nothing else.
pub(crate) struct Request {
    destination: Destination,
}

impl Request {
    /// Check a request to `url`. An IP literal is checked here; a name is
    /// checked when the resolver answers. A redirect's next hop is a request
    /// of its own.
    pub(crate) fn check(url: &str, exempt: Option<SocketAddr>) -> Result<Self, CheckError> {
        let parsed =
            url::Url::parse(url).map_err(|error| CheckError::Invalid(format!("{url}: {error}")))?;
        let destination = Destination::of(&parsed).map_err(CheckError::Invalid)?;
        destination
            .check_literal(exempt)
            .map_err(CheckError::Refused)?;
        Ok(Self { destination })
    }

    /// Run `send`, the request's future, with this request's checks in force
    /// for every connection it makes.
    pub(crate) async fn send<F: std::future::Future>(self, send: F) -> F::Output {
        CHECKED
            .scope(
                Checked {
                    hop: self.destination,
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

/// Resolves only within a checked request, to the addresses that pass.
struct Resolver;

impl reqwest::dns::Resolve for Resolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        // Read now: the connector calls this while the request is polled.
        let checked = CHECKED.try_with(|checked| checked.hop.clone());
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
/// would connect on the Worker's behalf to an address no check saw. It never
/// follows a redirect, because an IP literal in a `Location` reaches no
/// resolver: each hop must be a request of its own, checked by
/// [`Request::check`].
pub(crate) fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .dns_resolver(std::sync::Arc::new(Resolver))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
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
    connect_first(addresses, &destination.authority).await
}

/// Open a `connect()` socket from `cloudflare:sockets` to `hostname:port`.
/// The API is the operator-network tool, so it reaches any address, public
/// or private, except the node's internal listener and advertise address.
/// A name is resolved here, and only its addresses that pass are dialed.
pub(crate) async fn connect_socket(
    hostname: &str,
    port: u16,
) -> Result<tokio::net::TcpStream, ConnectError> {
    let host = hostname
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(hostname)
        .to_ascii_lowercase();
    let literal = host.parse::<IpAddr>().ok();
    let authority = match literal {
        Some(ip) => SocketAddr::new(ip, port).to_string(),
        None => format!("{host}:{port}"),
    };
    let addresses: Vec<SocketAddr> = match literal {
        Some(ip) => vec![SocketAddr::new(ip, port)],
        None => tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(ConnectError::Io)?
            .collect(),
    };
    let node = NODE.get();
    let allowed: Vec<SocketAddr> = addresses
        .iter()
        .copied()
        .filter(|address| !node.is_some_and(|node| node.reached(&host, address.ip(), port)))
        .collect();
    if allowed.is_empty() && !addresses.is_empty() {
        return Err(ConnectError::Refused(Refused {
            authority,
            reason: Reason::Node,
        }));
    }
    connect_first(allowed, &authority).await
}

/// Connect to the first of `addresses` that answers, in order.
async fn connect_first(
    addresses: Vec<SocketAddr>,
    authority: &str,
) -> Result<tokio::net::TcpStream, ConnectError> {
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
            format!("{authority} resolved to no address"),
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
    fn the_exempt_address_holds_for_literals_and_never_for_names() {
        crate::asyncrt::test_host_runtime().block_on(async {
            // A container port on loopback, so `localhost` resolves to it.
            let container: SocketAddr = "127.0.0.1:9".parse().unwrap();
            assert!(Request::check("http://127.0.0.1:9/b", Some(container)).is_ok());
            let Err(CheckError::Refused(other)) =
                Request::check("http://127.0.0.1:10/", Some(container))
            else {
                panic!("another port of the container's address passed");
            };
            assert_eq!(other.reason, Reason::NotPublic);
            // A name that resolves to the container's address: its connection
            // would join the shared pool under the name, so the resolver
            // refuses it.
            let Ok(name) = Request::check("http://localhost:9/", Some(container)) else {
                panic!("a name was checked as a literal");
            };
            // In an async block: the resolver reads the request when it is
            // called, which must be inside `send`.
            let resolved = name
                .send(async {
                    reqwest::dns::Resolve::resolve(&Resolver, "localhost".parse().unwrap()).await
                })
                .await;
            let Err(error) = resolved else {
                panic!("the resolver let a name reach the container's address");
            };
            let refused = refusal(error.as_ref()).unwrap();
            assert_eq!(refused.reason, Reason::NotPublic);
            assert_eq!(refused.authority, "localhost:9");
        });
    }

    fn node(internal: &str, advertise: crate::startup::Advertise) -> NodeAddresses {
        NodeAddresses {
            internal: internal.parse().unwrap(),
            advertise,
        }
    }

    #[test]
    fn the_nodes_own_addresses_are_refused_even_when_allowed() {
        use crate::startup::Advertise;
        let policy = Policy::new(vec![
            entry(AllowHost::Ip(ip("127.0.0.1")), 7000),
            entry(AllowHost::Ip(ip("10.0.0.5")), 7443),
            entry(AllowHost::Name("node-1.fleet".into()), 7443),
            entry(AllowHost::Name("localhost".into()), 7000),
            entry(AllowHost::Ip(ip("127.0.0.1")), 11434),
        ]);
        let node = node(
            "127.0.0.1:7000",
            Advertise::Addr("10.0.0.5:7443".parse().unwrap()),
        );
        let check = |host: &str, address: &str, port| {
            verdict(&policy, Some(&node), host, ip(address), port, None)
        };
        // The internal listener, in every spelling that lands on it.
        assert_eq!(check("127.0.0.1", "127.0.0.1", 7000), Err(Reason::Node));
        assert_eq!(check("localhost", "127.0.0.1", 7000), Err(Reason::Node));
        assert_eq!(
            check("::ffff:7f00:1", "::ffff:127.0.0.1", 7000),
            Err(Reason::Node)
        );
        assert_eq!(check("0.0.0.0", "0.0.0.0", 7000), Err(Reason::Node));
        // The advertise address.
        assert_eq!(check("10.0.0.5", "10.0.0.5", 7443), Err(Reason::Node));
        // A container's exempt address cannot be one of them either.
        let exempt = Some("127.0.0.1:7000".parse().unwrap());
        assert_eq!(
            verdict(
                &policy,
                Some(&node),
                "127.0.0.1",
                ip("127.0.0.1"),
                7000,
                exempt
            ),
            Err(Reason::Node)
        );
        // Another allowed port on the same address still passes.
        assert_eq!(check("127.0.0.1", "127.0.0.1", 11434), Ok(()));
        // Without the node's addresses, the allowlist alone decides.
        assert_eq!(
            verdict(&policy, None, "127.0.0.1", ip("127.0.0.1"), 7000, None),
            Ok(())
        );
    }

    #[test]
    fn every_interface_address_is_local() {
        let addresses = interface_addresses().unwrap();
        assert!(addresses.contains(&ip("127.0.0.1")), "{addresses:?}");
        for address in addresses {
            assert!(is_local_address(address), "{address}");
            assert!(lands_on(ip("0.0.0.0"), address), "{address}");
        }
        // TEST-NET-3 is never assigned to an interface.
        assert!(!is_local_address(ip("203.0.113.7")));
        assert!(!lands_on(ip("0.0.0.0"), ip("203.0.113.7")));
    }

    #[test]
    fn a_wildcard_listener_is_refused_on_every_local_address() {
        use crate::startup::Advertise;
        let policy = Policy::new(vec![
            entry(AllowHost::Ip(ip("127.0.0.2")), 7000),
            entry(AllowHost::Ip(ip("::1")), 7000),
            entry(AllowHost::Name("node-1.fleet".into()), 7000),
        ]);
        let node = node(
            "0.0.0.0:7000",
            Advertise::Name {
                host: "Node-1.Fleet".into(),
                port: 7000,
            },
        );
        let check = |host: &str, address: &str, port| {
            verdict(&policy, Some(&node), host, ip(address), port, None)
        };
        assert_eq!(check("127.0.0.2", "127.0.0.2", 7000), Err(Reason::Node));
        assert_eq!(check("::1", "::1", 7000), Err(Reason::Node));
        // The advertised name, however it resolves.
        assert_eq!(check("node-1.fleet", "10.9.9.9", 7000), Err(Reason::Node));
        assert_eq!(check("node-1.fleet.", "10.9.9.9", 7000), Err(Reason::Node));
        // A public address that is not this host's is someone else's port.
        assert_eq!(check("1.1.1.1", "1.1.1.1", 7000), Ok(()));
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
