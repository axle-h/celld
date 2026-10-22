// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The local application stack behind `celld dev`.
//!
//! Development still uses the standalone deployment, ownership, and LTX
//! paths. This module supplies only the infrastructure those paths require:
//! one persisted local object store and one supervised celld node.

use crate::bucket::Bucket;
use crate::{deploy, fleet};
use anyhow::{bail, Context as _};
use glob::{MatchOptions, Pattern};
use notify::{RecursiveMode, Watcher as _};
use nu_ansi_term::{Color, Style};
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::IsTerminal as _;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

pub const DEFAULT_PORT: u16 = 9876;
const BUCKET: &str = "celld-dev";

/// The narrow bridge used by the supervised binary process. The public fleet
/// parser never receives this path, so no regular subcommand can select it.
#[doc(hidden)]
pub fn open_local_bucket(database: &Path) -> anyhow::Result<Bucket> {
    Bucket::open_dev(database)
}

#[derive(Debug)]
struct Options {
    /// The configs in command-line order. The first is the primary, as for
    /// `wrangler dev -c`. Empty means the current directory.
    configs: Vec<PathBuf>,
    clean: bool,
    stack: StackOptions,
}

/// The local state directory of one project.
///
/// `--clean` deletes this directory and everything below it. The path is
/// private and the only constructor takes the project directory that `run`
/// resolved, so a command-line value can never become the target of the
/// delete. A newtype carries that rule instead of a comment, because a
/// `PathBuf` field would let a later caller pass any path and lose nothing at
/// compile time.
#[derive(Debug)]
struct DevState {
    path: PathBuf,
}

impl DevState {
    /// The project-relative location of the local state, and also the suffix
    /// that `discard` requires before it deletes.
    const DIRECTORY: &'static str = ".celld/dev";

    fn for_project(project: &Path) -> Self {
        Self {
            path: project.join(Self::DIRECTORY),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// Delete the local state so the next run starts from nothing. The answer
    /// reports whether a directory was present, because the console line for
    /// an empty project must not claim that data was removed.
    ///
    /// An absent directory is the wanted result of this command, so it is not
    /// an error.
    #[allow(clippy::disallowed_methods)] // Local development state is an operator-owned host path.
    fn discard(&self) -> anyhow::Result<bool> {
        // The constructor already guarantees this. The check stays because it
        // is the tripwire for a future constructor that takes a path: a
        // recursive delete must never widen by accident.
        anyhow::ensure!(
            self.path.ends_with(Self::DIRECTORY),
            "refusing to discard {}, which is not a celld dev state directory",
            self.path.display()
        );
        match std::fs::remove_dir_all(&self.path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error)
                .with_context(|| format!("discard local state directory {}", self.path.display())),
        }
    }
}

#[derive(Debug)]
struct StackOptions {
    listener: SocketAddr,
    /// `--internal-port`: the operator listener's port on loopback, 0 for a
    /// free one at each start.
    internal_port: u16,
    logs: bool,
    watch: bool,
    watch_ignores: Vec<Pattern>,
    /// `--no-build`: skip every config's `build.command`.
    no_build: bool,
}

struct Store {
    database: PathBuf,
}

#[derive(Clone, Copy)]
struct Console {
    color: bool,
}

impl Console {
    fn new() -> Self {
        let force = std::env::var_os("FORCE_COLOR").is_some_and(|value| value != "0");
        let color =
            std::env::var_os("NO_COLOR").is_none() && (force || std::io::stderr().is_terminal());
        Self { color }
    }

    fn paint(&self, style: Style, value: &str) -> String {
        if self.color {
            style.paint(value).to_string()
        } else {
            value.to_string()
        }
    }

    fn header(&self) {
        crate::note!("{}", self.paint(Color::Cyan.bold(), "celld dev"));
    }

    fn detail(&self, label: &str, value: &str) {
        crate::note!(
            "  {}  {value}",
            self.paint(Style::new().dimmed(), &format!("{label:<7}"))
        );
    }

    fn progress(&self, message: &str) {
        crate::note!("  {} {message}", self.paint(Color::Yellow.normal(), "●"));
    }

    fn ready(&self, origin: &str) {
        crate::note!(
            "  {}  {}",
            self.paint(Color::Green.bold(), "ready"),
            self.paint(Color::Cyan.bold(), origin)
        );
    }

    fn log(&self, line: &str) {
        let style = if line.contains(" ERROR ") {
            Color::Red.normal()
        } else if line.contains(" WARN ") {
            Color::Yellow.normal()
        } else {
            Style::new().dimmed()
        };
        crate::note!("{}", self.paint(style, line));
    }

    fn warning(&self, message: &str) {
        crate::note!(
            "  {} {message}",
            self.paint(Color::Yellow.bold(), "warning")
        );
    }

    fn failure(&self, message: &str) {
        crate::note!("  {} {message}", self.paint(Color::Red.bold(), "error"));
    }
}

/// One directory `celld dev` watches recursively.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchRoot {
    path: PathBuf,
    /// What `--watch-ignore` globs and the ignored directory names are
    /// relative to: the config's directory, or the root itself when it is a
    /// `build.watch_dir` outside that directory.
    base: PathBuf,
}

/// Everything `celld dev` watches: each config's directory, and each
/// `build.watch_dir` outside it, for a config whose build command runs.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct WatchPlan {
    roots: Vec<WatchRoot>,
}

impl WatchPlan {
    #[allow(clippy::disallowed_methods)] // Project resolution uses the operator's host filesystem.
    fn for_configs(
        configs: &[PathBuf],
        run_build: bool,
        console: &Console,
    ) -> anyhow::Result<Self> {
        let mut plan = Self::default();
        for config in configs {
            let project = project_directory(config)?.to_path_buf();
            plan.roots.push(WatchRoot {
                path: project.clone(),
                base: project.clone(),
            });
            if !run_build {
                continue;
            }
            for dir in deploy::build_watch_dirs(config)? {
                // The project's watch covers a directory inside it, also one
                // the first build creates.
                if lexical(&dir).starts_with(&project) {
                    continue;
                }
                match std::fs::canonicalize(&dir) {
                    Ok(dir) if dir.starts_with(&project) => {}
                    Ok(dir) if dir.is_dir() => plan.roots.push(WatchRoot {
                        base: dir.clone(),
                        path: dir,
                    }),
                    _ => console.warning(&format!(
                        "{} sets build.watch_dir {}, which is not a directory; a change there \
                         does not rebuild",
                        config.display(),
                        dir.display()
                    )),
                }
            }
        }
        Ok(plan)
    }

    /// Every project directory, as when no config has a build command.
    #[cfg(test)]
    fn projects(projects: &[PathBuf]) -> Self {
        Self {
            roots: projects
                .iter()
                .map(|project| WatchRoot {
                    path: project.clone(),
                    base: project.clone(),
                })
                .collect(),
        }
    }
}

/// The SHA-256 of a file's content, or `None` when it cannot be read, such
/// as a directory or a removed file.
#[allow(clippy::disallowed_methods)] // Project files on the operator's host filesystem.
fn content_digest(path: &Path) -> Option<[u8; 32]> {
    std::fs::read(path)
        .ok()
        .map(|content| Sha256::digest(content).into())
}

/// `path` with its `.` and `..` components resolved, without the filesystem.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            component => out.push(component),
        }
    }
    out
}

struct ProjectWatcher {
    plan: WatchPlan,
    ignored: Vec<Pattern>,
    _watcher: notify::RecommendedWatcher,
    changes: mpsc::UnboundedReceiver<notify::Result<notify::Event>>,
    /// Every path a relevant change named, so far.
    touched: BTreeSet<PathBuf>,
    /// The content of each touched path when the current rebuild started.
    baseline: BTreeMap<PathBuf, Option<[u8; 32]>>,
    /// A change that [`Self::discard_unchanged`] kept: the next
    /// [`Self::changed`] reports it at once.
    kept: bool,
}

impl ProjectWatcher {
    fn new(plan: WatchPlan, ignored: Vec<Pattern>) -> anyhow::Result<Self> {
        let (sender, changes) = mpsc::unbounded_channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .context("create the project watcher")?;
        let paths: Vec<PathBuf> = plan.roots.iter().map(|root| root.path.clone()).collect();
        for root in watch_roots(&paths) {
            watcher
                .watch(root, RecursiveMode::Recursive)
                .with_context(|| format!("watch the project directory {}", root.display()))?;
        }
        Ok(Self {
            plan,
            ignored,
            _watcher: watcher,
            changes,
            touched: BTreeSet::new(),
            baseline: BTreeMap::new(),
            kept: false,
        })
    }

    #[allow(clippy::disallowed_methods)] // Host-side debounce time is outside the Actor domain.
    async fn changed(&mut self) -> anyhow::Result<()> {
        if !std::mem::take(&mut self.kept) {
            self.next_relevant_change().await?;
        }
        loop {
            // An editor can replace one save through several writes and a
            // rename. Wait for one quiet interval so esbuild never reads the
            // temporary middle of that transaction.
            match tokio::time::timeout(Duration::from_millis(150), self.next_relevant_change())
                .await
            {
                Ok(result) => result?,
                Err(_) => return Ok(()),
            }
        }
    }

    async fn next_relevant_change(&mut self) -> anyhow::Result<()> {
        loop {
            match self
                .changes
                .recv()
                .await
                .context("the project watcher stopped")?
            {
                Ok(event) if relevant_project_event(&self.plan, &event, &self.ignored) => {
                    self.touched.extend(event.paths);
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) => return Err(error).context("watch the project directory"),
            }
        }
    }

    /// Record the content of every path a change has named, as a rebuild
    /// starts.
    fn snapshot(&mut self) {
        self.baseline = self
            .touched
            .iter()
            .map(|path| (path.clone(), content_digest(path)))
            .collect();
    }

    /// After a rebuild that deployed what already runs: drop the changes that
    /// arrived meanwhile to paths whose content is what it was when the
    /// rebuild started, which are the build's own rewrites. Any other change,
    /// such as a save during the build, stays, and the next
    /// [`Self::changed`] reports it.
    fn discard_unchanged(&mut self) {
        while let Ok(event) = self.changes.try_recv() {
            let Ok(event) = event else {
                continue;
            };
            if !relevant_project_event(&self.plan, &event, &self.ignored) {
                continue;
            }
            for path in event.paths {
                let unchanged = self
                    .baseline
                    .get(&path)
                    .is_some_and(|before| *before == content_digest(&path));
                self.kept |= !unchanged;
                self.touched.insert(path);
            }
        }
    }
}

/// The directories to watch recursively. A recursive watch already covers a
/// project inside another one, or a second config in the same directory, and
/// a second watch would only deliver each event twice.
fn watch_roots(projects: &[PathBuf]) -> Vec<&PathBuf> {
    projects
        .iter()
        .enumerate()
        .filter(|(index, project)| {
            !projects.iter().enumerate().any(|(other, outer)| {
                project.starts_with(outer) && (outer != *project || other < *index)
            })
        })
        .map(|(_, project)| project)
        .collect()
}

fn relevant_project_event(plan: &WatchPlan, event: &notify::Event, ignored: &[Pattern]) -> bool {
    // A read is not a change. The inotify backend reports `Access(Open(Any))`
    // for every file that the bundler and the deploy step read, so a rebuild
    // produces the events that request the next rebuild and the supervisor
    // never settles. The path filters cannot close this loop, because the
    // files that the rebuild reads are the project sources it must watch. A
    // write still arrives as a `Modify` event, and a `Create` or a `Remove`
    // event keeps its own kind, so no real change becomes invisible.
    if matches!(event.kind, notify::EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|path| {
        // The ignore rules are relative to the project that owns the path,
        // which is the innermost one when one project contains another. A
        // path outside every root cannot be judged, so it rebuilds.
        plan.roots
            .iter()
            .filter(|root| path.starts_with(&root.path))
            .max_by_key(|root| root.path.components().count())
            .is_none_or(|root| !ignored_project_path(&root.base, path, ignored))
    })
}

fn ignored_project_path(project: &Path, path: &Path, ignored: &[Pattern]) -> bool {
    const IGNORED_DIRECTORIES: &[&str] = &[
        ".cache",
        ".celld",
        ".git",
        ".hg",
        ".next",
        ".nuxt",
        ".parcel-cache",
        ".pnpm-store",
        ".svn",
        ".turbo",
        ".wrangler",
        ".yarn",
        "bower_components",
        "coverage",
        "node_modules",
        "target",
    ];
    let relative = path.strip_prefix(project).unwrap_or(path);
    relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(name) => Some(name),
            _ => None,
        })
        .any(|name| IGNORED_DIRECTORIES.iter().any(|ignored| name == *ignored))
        || relative.ancestors().any(|candidate| {
            !candidate.as_os_str().is_empty()
                && ignored.iter().any(|pattern| {
                    let options = MatchOptions {
                        case_sensitive: true,
                        require_literal_separator: true,
                        require_literal_leading_dot: true,
                    };
                    pattern.matches_path_with(candidate, options)
                        // A directory creation event arrives before its child
                        // path. Probe one child so `generated/**` also ignores
                        // the event that creates `generated` itself.
                        || pattern.matches_path_with(
                            &candidate.join("__celld_watch_descendant__"),
                            options,
                        )
                })
        })
}

#[cfg(all(test, celld_internal_tests))]
mod dev_contract {
    include!(env!("CELLD_INTERNAL_DEV_TESTS"));
}

struct ShutdownSignals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
}

impl ShutdownSignals {
    fn install() -> anyhow::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self {
                interrupt: tokio::signal::unix::signal(
                    tokio::signal::unix::SignalKind::interrupt(),
                )?,
                terminate: tokio::signal::unix::signal(
                    tokio::signal::unix::SignalKind::terminate(),
                )?,
            })
        }
        #[cfg(not(unix))]
        {
            Ok(Self {})
        }
    }

    async fn received(&mut self) {
        #[cfg(unix)]
        crate::asyncrt::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub fn print_help() -> anyhow::Result<()> {
    crate::cli_output::Output::new(crate::cli_output::Format::Text).help(
        &format!("celld dev — run an application with persistent local storage\n\n\
USAGE:\n  celld dev [PROJECT] [-c CONFIG]... [--host IP] [--port PORT] [--internal-port PORT] [--logs] [--no-watch] [--no-build] [--clean]\n\n\
PROJECT and each -c CONFIG are a directory or a Wrangler config. Without\n\
either, celld uses the current directory. Several run together, as with\n\
wrangler dev -c. The first one named is the primary: it serves the Worker\n\
listener, and the others serve through its service bindings.\n\n\
celld stores all local state in the primary's .celld/dev, and it keeps that\n\
state across a restart. A configuration change does not migrate the state,\n\
so a cell can keep a value that the new configuration rejects. Use --clean\n\
to start from an empty local state, also after removing a config.\n\n\
A .dev.vars file beside each config supplies its Worker variables in dotenv\n\
form, as for wrangler dev. Without one, .env and then .env.local supply\n\
them, and an entry of these files that cannot be a binding is skipped with\n\
a warning. The entries override the vars of that config only.\n\n\
When the node is ready, and again after each rebuild that changed the\n\
application, celld prints one JSON line to stdout with the Worker and\n\
operator origins.\n\n\
A config's build.command runs before each build, as for wrangler dev, with\n\
its output on stderr. celld watches each config's directory, and also its\n\
build.watch_dir (default: src) when that is outside the directory. A\n\
rebuild that deploys what already runs keeps the node running.\n\n\
OPTIONS:\n  -c, --config PATH      A config or project directory; repeat as needed\n  --host IP              Worker listener host (default: 127.0.0.1)\n  --port PORT            Worker listener port (default: {DEFAULT_PORT}; 0 picks a free one)\n  --internal-port PORT   Operator listener port on 127.0.0.1 (default: 0, a free one)\n  --clean                Delete the primary's .celld/dev before the server starts\n  --logs                 Show the node warning and information logs\n  --no-watch             Do not rebuild when a project file changes\n  --no-build             Do not run the configs' build.command\n  --watch-ignore PATTERN Ignore a project-relative glob; repeat as needed\n  -h, --help             Show this help"
        ),
    )
}

fn options_from_arguments(arguments: Vec<String>) -> anyhow::Result<Option<Options>> {
    let mut configs = Vec::new();
    let mut positional = false;
    let mut host = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut port = DEFAULT_PORT;
    let mut internal_port = 0;
    let mut clean = false;
    let mut logs = false;
    let mut watch = true;
    let mut watch_ignores = Vec::new();
    let mut no_build = false;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--help" | "-h" => return Ok(None),
            "--clean" => clean = true,
            "--logs" => logs = true,
            "--no-watch" => watch = false,
            "--no-build" => no_build = true,
            "--config" | "-c" => {
                let value = arguments.next().context("--config requires a value")?;
                configs.push(PathBuf::from(value));
            }
            "--watch-ignore" => {
                let value = arguments
                    .next()
                    .context("--watch-ignore requires a value")?;
                watch_ignores.push(
                    Pattern::new(&value)
                        .with_context(|| format!("invalid --watch-ignore pattern {value:?}"))?,
                );
            }
            "--host" => {
                let value = arguments.next().context("--host requires a value")?;
                host = value
                    .parse::<IpAddr>()
                    .with_context(|| format!("invalid --host value {value:?}"))?;
            }
            "--port" => {
                let value = arguments.next().context("--port requires a value")?;
                port = value
                    .parse::<u16>()
                    .with_context(|| format!("invalid --port value {value:?}"))?;
            }
            "--internal-port" => {
                let value = arguments
                    .next()
                    .context("--internal-port requires a value")?;
                internal_port = value
                    .parse::<u16>()
                    .with_context(|| format!("invalid --internal-port value {value:?}"))?;
            }
            other if other.starts_with('-') => bail!("unknown argument for `celld dev`: {other}"),
            value if !positional => {
                positional = true;
                configs.push(PathBuf::from(value));
            }
            value => bail!("celld dev accepts one PROJECT, but also received {value:?}"),
        }
    }
    if !watch && !watch_ignores.is_empty() {
        bail!("--watch-ignore cannot be used with --no-watch");
    }
    Ok(Some(Options {
        configs,
        clean,
        stack: StackOptions {
            listener: SocketAddr::new(host, port),
            internal_port,
            logs,
            watch,
            watch_ignores,
            no_build,
        },
    }))
}

#[allow(clippy::disallowed_methods)] // Project resolution uses the operator's host filesystem.
pub async fn run(arguments: Vec<String>) -> anyhow::Result<()> {
    let Some(options) = options_from_arguments(arguments)? else {
        print_help()?;
        return Ok(());
    };
    let configs = resolve_configs(options.configs)?;
    let project = project_directory(&configs[0])?;
    let state = DevState::for_project(project);
    let console = Console::new();
    console.header();
    for (index, config) in configs.iter().enumerate() {
        let primary = if index == 0 && configs.len() > 1 {
            " (primary)"
        } else {
            ""
        };
        console.detail("Project", &format!("{}{primary}", config.display()));
    }
    console.detail("State", &state.path().display().to_string());
    // The delete runs before the directory is recreated, and the console names
    // the outcome. A developer who reaches for this flag is already unsure
    // which state the run uses, so a silent delete would answer nothing.
    if options.clean {
        let discarded = state.discard()?;
        console.detail(
            "Clean",
            if discarded {
                "discarded the existing local state"
            } else {
                "no local state to discard"
            },
        );
    }
    prepare_state(state.path())?;
    if !options.stack.logs {
        console.detail("Logs", "hidden (use --logs)");
    }
    if !options.stack.watch {
        console.detail("Watch", "disabled");
    }
    if options.stack.no_build {
        console.detail("Build", "build.command skipped (--no-build)");
    }

    let project_hash = format!(
        "{:x}",
        Sha256::digest(project.as_os_str().as_encoded_bytes())
    );
    let store = open_store(state.path(), &console).await?;
    run_stack(
        &configs,
        state.path(),
        options.stack,
        &project_hash,
        &store,
        &console,
    )
    .await
}

/// The canonical config paths, the primary first. A config named twice, also
/// as a directory and as the file in it, is refused: it would deploy one
/// Worker twice, and the second copy would decide which one is primary.
#[allow(clippy::disallowed_methods)] // Project resolution uses the operator's host filesystem.
fn resolve_configs(given: Vec<PathBuf>) -> anyhow::Result<Vec<PathBuf>> {
    let given = if given.is_empty() {
        vec![None]
    } else {
        given.into_iter().map(Some).collect()
    };
    let mut configs: Vec<PathBuf> = Vec::with_capacity(given.len());
    for path in given {
        let config = deploy::resolve_config(path)?;
        let config = std::fs::canonicalize(&config)
            .with_context(|| format!("resolve Wrangler config {}", config.display()))?;
        if configs.contains(&config) {
            bail!(
                "the Wrangler config {} is given more than once",
                config.display()
            );
        }
        configs.push(config);
    }
    Ok(configs)
}

fn project_directory(config: &Path) -> anyhow::Result<&Path> {
    config
        .parent()
        .context("the Wrangler config has no project directory")
}

#[allow(clippy::disallowed_methods)] // Local development state is an operator-owned host path.
fn prepare_state(state: &Path) -> anyhow::Result<()> {
    for directory in [state.to_path_buf(), state.join("runtime")] {
        std::fs::create_dir_all(&directory)
            .with_context(|| format!("create local state directory {}", directory.display()))?;
    }
    Ok(())
}

#[allow(clippy::disallowed_methods)] // Local development state is an operator-owned host path.
async fn open_store(state: &Path, console: &Console) -> anyhow::Result<Store> {
    console.progress("opening the local storage");
    let database = std::fs::canonicalize(state)
        .context("resolve the local state directory")?
        .join("objects.sqlite3");
    let bucket = open_local_bucket(&database)?;
    fleet::validate_bucket(&bucket).await?;
    bucket.probe_cas().await?;
    Ok(Store { database })
}

/// The Worker variables for `celld dev`, from the files that `wrangler dev`
/// reads beside the config (Wrangler getVarsForDev()). A `.dev.vars` file
/// wins outright. Without one, `.env` and then `.env.local` apply, and a later
/// file overrides an earlier one. Each entry overrides the `vars` of the
/// config. Only `celld dev` reads the files, so a local credential cannot
/// reach a fleet.
fn read_dev_vars(config: &Path) -> anyhow::Result<deploy::VarOverrides> {
    // A present `.dev.vars` replaces the dotenv files even when it is empty,
    // as in Wrangler, so an entry that the project keeps in `.env` for
    // another tool does not reach the Worker beside it.
    if let Some(contents) = read_optional(&config.with_file_name(".dev.vars"))? {
        return Ok(deploy::VarOverrides::DevVars(parse_dotenv(&contents)));
    }
    let mut vars = BTreeMap::new();
    for name in [".env", ".env.local"] {
        if let Some(contents) = read_optional(&config.with_file_name(name))? {
            vars.extend(parse_dotenv(&contents));
        }
    }
    // Only a config that declares `secrets` reads it, as in `wrangler dev`.
    let process = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    Ok(deploy::VarOverrides::DotEnv {
        files: vars,
        process,
    })
}

/// The contents of `path`, or `None` when it does not exist. One read, not an
/// existence probe and then a read, so a file that vanishes between the two
/// cannot fail the build.
#[allow(clippy::disallowed_methods)] // The project is on the operator's host filesystem.
fn read_optional(path: &Path) -> anyhow::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn parse_dotenv(contents: &str) -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    let mut lines = contents.lines();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // dotenv accepts the `export NAME=value` form of a shell-sourced
        // file. Without the strip, the name `export NAME` fails binding
        // validation, and a `.env` that loaded before stops the build.
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let (name, value) = (name.trim(), value.trim());
        if name.is_empty() {
            continue;
        }
        let value = match quoted_lines(value, &mut lines) {
            Some(value) => value,
            // One matched pair of quotes comes off; a lone quote is part of
            // the value, as in dotenv, so a secret that ends in one survives.
            None => ['"', '\'']
                .into_iter()
                .find_map(|quote| value.strip_prefix(quote)?.strip_suffix(quote))
                .unwrap_or(value)
                .to_string(),
        };
        vars.insert(name.to_string(), value);
    }
    vars
}

/// A quoted value that continues on the following lines, as dotenv reads a
/// PEM key, joined by newlines without its quotes. Line by line, each base64
/// line of the key became a variable of its own or a name that fails binding
/// validation. `None` leaves `lines` untouched: the value ends on its own
/// line, or no later line closes the quote, so the opening quote is a lone
/// character of a one-line value.
fn quoted_lines(value: &str, lines: &mut std::str::Lines<'_>) -> Option<String> {
    let quote = value
        .chars()
        .next()
        .filter(|quote| matches!(quote, '"' | '\''))?;
    let first = &value[1..];
    if first.ends_with(quote) {
        return None;
    }
    let mut rest = lines.clone();
    let mut joined = first.to_string();
    while let Some(line) = rest.next() {
        joined.push('\n');
        match line.trim_end().strip_suffix(quote) {
            Some(last) => {
                joined.push_str(last);
                *lines = rest;
                return Some(joined);
            }
            None => joined.push_str(line),
        }
    }
    None
}

/// Build every config, then write them with the primary last.
#[cfg(test)]
async fn deploy_projects(
    configs: &[PathBuf],
    store: &Store,
    logs: bool,
    no_build: bool,
) -> anyhow::Result<()> {
    let builds = spawn_builds(configs.to_vec(), no_build)
        .await
        .context("the build task failed")??;
    write_builds(&builds, store, logs).await
}

/// What a set of builds deploys: each Worker's name and deployment version,
/// which hashes its code, metadata and assets.
fn versions(builds: &[(PathBuf, deploy::Built)]) -> Vec<(String, String)> {
    builds
        .iter()
        .map(|(_, built)| (built.script_name.clone(), built.version.clone()))
        .collect()
}

/// Build every config, in write order, off the async runtime: a build
/// command can run for minutes, and `celld dev` must still answer a signal
/// meanwhile.
#[allow(clippy::disallowed_methods)] // The build is host work outside the Actor domain.
fn spawn_builds(
    configs: Vec<PathBuf>,
    no_build: bool,
) -> tokio::task::JoinHandle<anyhow::Result<Vec<(PathBuf, deploy::Built)>>> {
    tokio::task::spawn_blocking(move || {
        let mut builds: Vec<(PathBuf, deploy::Built)> = Vec::with_capacity(configs.len());
        for config in deploy_order(&configs) {
            if deploy::builds_stopping() {
                bail!("celld dev is stopping");
            }
            let built = deploy::build(&deploy::Options {
                config: Some(config.clone()),
                bucket: None,
                endpoint: None,
                region: None,
                dry_run: false,
                json: false,
                vars: read_dev_vars(config)?,
                no_build,
                dev: true,
                local_images: true,
            })?;
            // One name is one pointer, so a second config with the name would
            // silently replace the first.
            if let Some((other, _)) = builds
                .iter()
                .find(|(_, other)| other.script_name == built.script_name)
            {
                bail!(
                    "{} and {} both name the Worker {:?}",
                    other.display(),
                    config.display(),
                    built.script_name
                );
            }
            builds.push((config.clone(), built));
        }
        Ok(builds)
    })
}

/// Write the builds, the primary last. Only the primary's write moves the
/// fleet pointer, which selects the application, so neither a failed build
/// nor a failed write can select another Worker.
async fn write_builds(
    builds: &[(PathBuf, deploy::Built)],
    store: &Store,
    logs: bool,
) -> anyhow::Result<()> {
    let bucket = open_local_bucket(&store.database)?;
    if logs {
        for (_, built) in builds {
            built.report();
        }
    }
    crate::wake_format::ensure_ready(&bucket).await?;
    let (primary, components) = builds
        .split_last()
        .expect("celld dev resolves at least one config");
    for (_, built) in components {
        deploy::write_component(&bucket, built).await?;
    }
    deploy::write(&bucket, &primary.1).await
}

/// How a build that a signal can interrupt ended.
enum Built {
    Done(Vec<(PathBuf, deploy::Built)>),
    /// SIGINT or SIGTERM arrived: the build commands were stopped.
    Interrupted,
}

/// Build every config, or stop the build on a shutdown signal: SIGTERM to
/// the build commands, SIGKILL two seconds later, or at once on a second
/// signal.
#[allow(clippy::disallowed_methods)] // Waiting on host processes outside the Actor domain.
async fn build_or_stop(
    configs: &[PathBuf],
    no_build: bool,
    signals: &mut ShutdownSignals,
) -> anyhow::Result<Built> {
    let mut builds = spawn_builds(configs.to_vec(), no_build);
    crate::asyncrt::select! {
        result = &mut builds => return Ok(Built::Done(result.context("the build task failed")??)),
        _ = signals.received() => {}
    }
    #[cfg(unix)]
    {
        let mut stopping =
            tokio::task::spawn_blocking(|| deploy::stop_builds(Duration::from_secs(2)));
        crate::asyncrt::select! {
            _ = &mut stopping => {}
            _ = signals.received() => deploy::kill_builds(),
        }
        let _ = stopping.await;
    }
    // The task ends once its build command has; wait, so nothing the build
    // started outlives `celld dev`.
    let _ = builds.await;
    Ok(Built::Interrupted)
}

/// The configs in write order: the primary, which is first on the command
/// line, comes last.
fn deploy_order(configs: &[PathBuf]) -> impl Iterator<Item = &PathBuf> {
    configs.iter().skip(1).chain(configs.first())
}

async fn run_stack(
    configs: &[PathBuf],
    state: &Path,
    mut options: StackOptions,
    project_hash: &str,
    store: &Store,
    console: &Console,
) -> anyhow::Result<()> {
    // Install both handlers before the child can become ready. A caller can
    // send SIGTERM as soon as the readiness request answers, and installing a
    // handler afterwards leaves the new node orphaned under the default Unix
    // signal action.
    let mut signals = ShutdownSignals::install()?;
    let run_build = !options.no_build;
    let mut watcher = options
        .watch
        .then(|| {
            ProjectWatcher::new(
                WatchPlan::for_configs(configs, run_build, console)?,
                std::mem::take(&mut options.watch_ignores),
            )
        })
        .transpose()?;

    console.progress("building the application");
    let builds = match build_or_stop(configs, options.no_build, &mut signals).await? {
        Built::Done(builds) => builds,
        Built::Interrupted => return Ok(()),
    };
    write_builds(&builds, store, options.logs).await?;
    let mut deployed = versions(&builds);
    let mut running = start_node(
        state,
        options.listener,
        options.internal_port,
        options.logs,
        project_hash,
        store,
        console,
    )
    .await?;
    // A restart keeps the port that `--port 0` drew, so the origin in the
    // first ready line stays valid for the whole session. Another process can
    // take the port while the node restarts; that start then fails loudly.
    options.listener = running.public;

    loop {
        match wait_for_node_event(&mut running.child, &mut signals, watcher.as_mut()).await? {
            NodeEvent::Exited(status) => {
                let _ = running.output.await;
                if status.success() {
                    return Ok(());
                }
                bail!("the local celld node exited with {status}");
            }
            NodeEvent::Shutdown => {
                stop_running_node(running).await;
                return Ok(());
            }
            NodeEvent::Reload => {
                console.progress("change detected; rebuilding the application");
                if let Some(watcher) = watcher.as_mut() {
                    watcher.snapshot();
                }
                let builds = match build_or_stop(configs, options.no_build, &mut signals).await {
                    Ok(Built::Done(builds)) => builds,
                    Ok(Built::Interrupted) => {
                        stop_running_node(running).await;
                        return Ok(());
                    }
                    Err(error) => {
                        console.failure(&format!("reload failed: {error:#}"));
                        continue;
                    }
                };
                // A config change can move `build.watch_dir`. A plan that
                // cannot be read or watched keeps the current one.
                if let Some(current) = watcher.as_mut() {
                    let replanned =
                        WatchPlan::for_configs(configs, run_build, console).and_then(|plan| {
                            if plan == current.plan {
                                return Ok(None);
                            }
                            ProjectWatcher::new(plan, current.ignored.clone()).map(Some)
                        });
                    match replanned {
                        Ok(Some(replaced)) => *current = replaced,
                        Ok(None) => {}
                        Err(error) => console.failure(&format!(
                            "kept watching the previous directories: {error:#}"
                        )),
                    }
                }
                // A build that writes into the watched directories reports
                // its own writes as changes. When the rebuild deploys what
                // already runs, a rewrite with the same content is no change:
                // drop those, so the build does not start itself again.
                if versions(&builds) == deployed {
                    console.progress("no change in the build; the application keeps running");
                    if let Some(watcher) = watcher.as_mut() {
                        watcher.discard_unchanged();
                    }
                    continue;
                }
                if let Err(error) = write_builds(&builds, store, options.logs).await {
                    console.failure(&format!("reload failed: {error:#}"));
                    continue;
                }
                deployed = versions(&builds);
                console.progress("restarting the application");
                stop_running_node(running).await;
                running = start_node(
                    state,
                    options.listener,
                    options.internal_port,
                    options.logs,
                    project_hash,
                    store,
                    console,
                )
                .await?;
            }
        }
    }
}

struct RunningNode {
    child: Child,
    public: SocketAddr,
    internal: String,
    output: tokio::task::JoinHandle<()>,
}

enum NodeEvent {
    Exited(std::process::ExitStatus),
    Reload,
    Shutdown,
}

#[allow(clippy::disallowed_methods)] // Child supervision uses real host process and time APIs.
async fn start_node(
    state: &Path,
    listener: SocketAddr,
    internal_port: u16,
    logs: bool,
    project_hash: &str,
    store: &Store,
    console: &Console,
) -> anyhow::Result<RunningNode> {
    let executable = std::env::current_exe().context("locate the celld executable")?;
    let listen = listener.to_string();
    let internal_listen = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), internal_port).to_string();
    let mut command = Command::new(executable);
    // The supervisor owns the child's complete storage and listener topology.
    // Inherited fleet settings can otherwise override that private topology or
    // make its guard reject a valid `celld dev` invocation.
    for variable in [
        "AWS_DEFAULT_REGION",
        "AWS_REGION",
        "CELLD_ADDR",
        "CELLD_ADVERTISE",
        "CELLD_BUCKET",
        "CELLD_CLOUD",
        "CELLD_INTERNAL_ADDR",
        "CELLD_TEST_BUCKET",
        "CELLD_TRUST_FORWARDED_HEADERS",
        "CELLD_UNSAFE_PUBLIC_ADVERTISE",
        "S3_ENDPOINT",
    ] {
        command.env_remove(variable);
    }
    command
        .args([
            "--no-control-plane",
            "--bucket",
            BUCKET,
            "--listen",
            &listen,
            "--internal-listen",
            &internal_listen,
        ])
        .env("CELLD_INTERNAL_DEV_STORE", &store.database)
        .env("CELLD_WATCH", state.join("runtime"))
        .env("CELLD_NODE", format!("dev-{}", &project_hash[..12]))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // `run_stack` normally consumes `RunningNode` through the graceful stop
    // path. An error or cancellation can instead drop it, so the child must
    // not outlive the value that proves the supervisor still owns it.
    command.kill_on_drop(true);
    if !logs {
        // The supervisor still forwards ERROR records and the child's stderr.
        // INFO and WARN records stay hidden until the operator asks for them.
        command.env("RUST_LOG", "error");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // A terminal sends Ctrl-C to its foreground process group. Keep the
        // node in a child group so only this supervisor selects the shutdown
        // mode; otherwise the node can begin a slow fleet handoff before the
        // supervisor asks for the fast same-node preserve path.
        command.as_std_mut().process_group(0);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt as _;

        let supervisor = unsafe { libc::getpid() };
        // Drop cannot run after SIGKILL or a supervisor crash. Ask the kernel
        // to kill the node in that case. The parent check closes the race in
        // which the supervisor exits between `fork` and `prctl`.
        unsafe {
            command.as_std_mut().pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != supervisor {
                    return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().context("start the local celld node")?;

    let stdout = child
        .stdout
        .take()
        .expect("the local node was configured with piped output");
    let (listeners_tx, listeners_rx) = oneshot::channel();
    let output_console = *console;
    let output = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut listeners_tx = Some(listeners_tx);
        // The node announces its Worker listener first, and then the
        // operator listener. `--port 0` makes the first the only source of
        // the Worker port.
        let mut public = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(address) = public_address(&line) {
                public.get_or_insert(address);
            }
            if let Some(origin) = internal_origin(&line) {
                if let (Some(public), Some(sender)) = (public, listeners_tx.take()) {
                    let _ = sender.send((public, origin));
                }
            }
            if logs || line.contains(" ERROR ") {
                output_console.log(&line);
            }
        }
    });
    let (public, internal) = match tokio::time::timeout(Duration::from_secs(30), listeners_rx).await
    {
        Ok(Ok(listeners)) => listeners,
        result => {
            stop_child(&mut child, None).await;
            let _ = output.await;
            match result {
                Err(_) => {
                    bail!("the local node did not announce its Worker and operator listeners")
                }
                Ok(Err(_)) => {
                    bail!(
                        "the local node exited before it announced its Worker and operator \
                         listeners"
                    )
                }
                Ok(Ok(_)) => unreachable!(),
            }
        }
    };

    if let Err(error) = wait_for_node(&mut child, public).await {
        stop_child(&mut child, Some(&internal)).await;
        let _ = output.await;
        return Err(error);
    }
    console.ready(&format!("http://{public}"));
    let announced = ready_line(public, &internal).and_then(|line| {
        crate::cli_output::Output::new(crate::cli_output::Format::Json).line(format_args!("{line}"))
    });
    if let Err(error) = announced {
        stop_child(&mut child, Some(&internal)).await;
        let _ = output.await;
        return Err(error);
    }
    Ok(RunningNode {
        child,
        public,
        internal,
        output,
    })
}

/// The stdout record that tells a test runner, or any other tool, where the
/// node serves. The public origin is one a client can connect to, so an
/// unspecified listener host becomes loopback.
fn ready_line(public: SocketAddr, internal: &str) -> anyhow::Result<String> {
    #[derive(serde::Serialize)]
    struct Ready<'a> {
        event: &'static str,
        public: String,
        internal: &'a str,
    }
    Ok(serde_json::to_string(&Ready {
        event: "ready",
        public: format!("http://{}", connectable(public)),
        internal,
    })?)
}

fn public_address(line: &str) -> Option<SocketAddr> {
    line.strip_prefix("celld listening on ")?
        .split_once(' ')?
        .0
        .parse()
        .ok()
}

fn internal_origin(line: &str) -> Option<String> {
    let address = line
        .strip_prefix("celld internal listening on ")?
        .split_once(' ')?
        .0;
    Some(format!("http://{address}"))
}

#[allow(clippy::disallowed_methods)] // Readiness waits on a real child and wall-clock deadline.
async fn wait_for_node(child: &mut Child, listener: SocketAddr) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(200))
        .timeout(Duration::from_secs(1))
        .build()?;
    let url = format!("http://{}/.well-known/celld/health", connectable(listener));
    let mut last = "the node did not answer".to_string();
    for _ in 0..300 {
        if let Some(status) = child.try_wait().context("read the local node status")? {
            bail!("the local celld node exited during startup with {status}");
        }
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => last = format!("the readiness endpoint returned {}", response.status()),
            Err(error) => last = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("the local celld node did not become ready: {last}")
}

/// `listener` with an unspecified host replaced by loopback of its family.
fn connectable(listener: SocketAddr) -> SocketAddr {
    let host = match listener.ip() {
        IpAddr::V4(address) if address.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(address) if address.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        address => address,
    };
    SocketAddr::new(host, listener.port())
}

async fn wait_for_node_event(
    child: &mut Child,
    signals: &mut ShutdownSignals,
    watcher: Option<&mut ProjectWatcher>,
) -> anyhow::Result<NodeEvent> {
    crate::asyncrt::select! {
        status = child.wait() => {
            let status = status.context("wait for the local celld node")?;
            Ok(NodeEvent::Exited(status))
        }
        _ = signals.received() => Ok(NodeEvent::Shutdown),
        changed = wait_for_project_change(watcher) => {
            changed?;
            Ok(NodeEvent::Reload)
        }
    }
}

async fn wait_for_project_change(watcher: Option<&mut ProjectWatcher>) -> anyhow::Result<()> {
    match watcher {
        Some(watcher) => watcher.changed().await,
        None => std::future::pending().await,
    }
}

async fn stop_running_node(mut running: RunningNode) {
    stop_child(&mut running.child, Some(&running.internal)).await;
    let _ = running.output.await;
}

#[allow(clippy::disallowed_methods)] // Shutdown deadlines govern a real child process.
async fn stop_child(child: &mut Child, internal: Option<&str>) {
    let requested = if let Some(internal) = internal {
        match reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(client) => client
                .post(format!("{internal}/shutdown?handoff=preserve"))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success()),
            Err(_) => false,
        }
    } else {
        false
    };
    #[cfg(unix)]
    if !requested {
        if let Some(id) = child.id() {
            // The child installs SIGTERM as its graceful durability handoff. The
            // supervisor sends that signal instead of Child::kill, which is a
            // SIGKILL on Unix and can leave the last local transaction unflushed.
            unsafe {
                libc::kill(id as libc::pid_t, libc::SIGTERM);
            }
        }
    }
    let waited = tokio::time::timeout(Duration::from_secs(35), child.wait()).await;
    if waited.is_err() {
        let _ = child.kill().await;
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // Tests build throwaway projects on the host filesystem.
mod tests {
    use super::*;
    use serde_json::json;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn configs(values: &[&str]) -> Vec<PathBuf> {
        options_from_arguments(arguments(values))
            .unwrap()
            .unwrap()
            .configs
    }

    fn project(root: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("wrangler.jsonc"), "{}").unwrap();
        for (file, contents) in files {
            std::fs::write(directory.join(file), contents).unwrap();
        }
        directory
    }

    #[test]
    fn one_config_is_positional_or_flagged() {
        assert_eq!(configs(&[]), Vec::<PathBuf>::new());
        assert_eq!(configs(&["front"]), [PathBuf::from("front")]);
        assert_eq!(configs(&["-c", "front"]), [PathBuf::from("front")]);
        assert_eq!(configs(&["--config", "front"]), [PathBuf::from("front")]);
    }

    #[test]
    fn several_configs_keep_command_line_order() {
        assert_eq!(
            configs(&["-c", "front", "-c", "back", "--config", "other"]),
            ["front", "back", "other"].map(PathBuf::from)
        );
        assert_eq!(
            configs(&["front", "-c", "back"]),
            ["front", "back"].map(PathBuf::from)
        );
        assert_eq!(
            configs(&["-c", "front", "back"]),
            ["front", "back"].map(PathBuf::from)
        );
    }

    #[test]
    fn a_second_positional_project_is_refused() {
        let error = options_from_arguments(arguments(&["front", "back"])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "celld dev accepts one PROJECT, but also received \"back\""
        );
        let error = options_from_arguments(arguments(&["-c"])).unwrap_err();
        assert_eq!(error.to_string(), "--config requires a value");
    }

    #[test]
    fn no_build_is_a_flag() {
        let parse = |values: &[&str]| options_from_arguments(arguments(values)).unwrap().unwrap();
        assert!(!parse(&[]).stack.no_build);
        assert!(parse(&["--no-build", "front"]).stack.no_build);
    }

    #[test]
    fn port_zero_is_accepted() {
        let options = options_from_arguments(arguments(&["--port", "0"]))
            .unwrap()
            .unwrap();
        assert_eq!(options.stack.listener.port(), 0);
    }

    #[test]
    fn the_internal_port_defaults_to_a_free_one() {
        let options = options_from_arguments(arguments(&[])).unwrap().unwrap();
        assert_eq!(options.stack.internal_port, 0);
        let options = options_from_arguments(arguments(&["--internal-port", "7001"]))
            .unwrap()
            .unwrap();
        assert_eq!(options.stack.internal_port, 7001);
        assert!(options_from_arguments(arguments(&["--internal-port", "x"])).is_err());
    }

    #[test]
    fn a_config_given_twice_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let front = project(root.path(), "front", &[]);
        let error = resolve_configs(vec![front.clone(), front.join("wrangler.jsonc")]).unwrap_err();
        let config = std::fs::canonicalize(front.join("wrangler.jsonc")).unwrap();
        assert_eq!(
            error.to_string(),
            format!(
                "the Wrangler config {} is given more than once",
                config.display()
            )
        );
    }

    #[test]
    fn configs_resolve_in_order() {
        let root = tempfile::tempdir().unwrap();
        let front = project(root.path(), "front", &[]);
        let back = project(root.path(), "back", &[]);
        let resolved = resolve_configs(vec![front.clone(), back.join("wrangler.jsonc")]).unwrap();
        assert_eq!(
            resolved,
            [front, back].map(|directory| {
                std::fs::canonicalize(directory.join("wrangler.jsonc")).unwrap()
            })
        );
    }

    #[test]
    fn the_primary_deploys_last() {
        let given = ["front", "back", "other"].map(PathBuf::from);
        assert_eq!(
            deploy_order(&given).collect::<Vec<_>>(),
            [&given[1], &given[2], &given[0]]
        );
        let single = [PathBuf::from("front")];
        assert_eq!(deploy_order(&single).collect::<Vec<_>>(), [&single[0]]);
    }

    /// The process runtime that the local store's I/O runs on.
    fn host_runtime() -> &'static tokio::runtime::Runtime {
        crate::asyncrt::test_host_runtime()
    }

    #[test]
    fn only_the_primary_selects_the_application() {
        // deploy_projects runs the dev builds, which a stopping test refuses.
        let _turn = DEV_BUILD.lock().unwrap_or_else(|e| e.into_inner());
        host_runtime().block_on(only_the_primary_selects_the_application_on_the_host());
    }

    async fn only_the_primary_selects_the_application_on_the_host() {
        let root = tempfile::tempdir().unwrap();
        let mut configs = Vec::new();
        for name in ["front", "back"] {
            let directory = root.path().join(name);
            std::fs::create_dir_all(directory.join("public")).unwrap();
            std::fs::write(directory.join("public/index.html"), name).unwrap();
            let config = directory.join("wrangler.jsonc");
            std::fs::write(
                &config,
                format!(
                    r#"{{"name":"{name}","compatibility_date":"2026-09-04","assets":{{"directory":"public"}}}}"#
                ),
            )
            .unwrap();
            configs.push(config);
        }
        let store = Store {
            database: root.path().join("objects.sqlite3"),
        };
        let bucket = open_local_bucket(&store.database).unwrap();
        let script = |key: &'static str| {
            let bucket = &bucket;
            async move {
                let (body, _) = bucket.get(key).await.unwrap()?;
                let pointer: serde_json::Value = serde_json::from_slice(&body).unwrap();
                Some(pointer["script_name"].as_str().unwrap().to_string())
            }
        };

        deploy_projects(&configs, &store, false, false)
            .await
            .unwrap();
        assert_eq!(
            script("deploy/current.json").await.as_deref(),
            Some("front")
        );
        assert_eq!(
            script("deploy/back/current.json").await.as_deref(),
            Some("back")
        );

        // A component write alone, as when the primary's write then fails,
        // names the component but leaves the application selected.
        let built = deploy::build(&deploy::Options {
            config: Some(configs[1].clone()),
            bucket: None,
            endpoint: None,
            region: None,
            dry_run: false,
            json: false,
            vars: deploy::VarOverrides::None,
            no_build: false,
            dev: true,
            local_images: true,
        })
        .unwrap();
        deploy::write_component(&bucket, &built).await.unwrap();
        assert_eq!(
            script("deploy/current.json").await.as_deref(),
            Some("front")
        );
    }

    /// An asset-only project whose build writes its assets, so its deploy
    /// succeeds only when the build ran.
    fn built_assets_project(root: &Path) -> PathBuf {
        let directory = root.join("site");
        std::fs::create_dir_all(&directory).unwrap();
        let config = directory.join("wrangler.jsonc");
        std::fs::write(
            &config,
            r#"{"name":"site","compatibility_date":"2026-09-04",
                "assets":{"directory":"public"},
                "build":{"command":"mkdir -p public && echo $WRANGLER_COMMAND > public/index.html"}}"#,
        )
        .unwrap();
        config
    }

    fn modified(path: PathBuf) -> notify::Event {
        notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any)).add_path(path)
    }

    #[test]
    fn a_build_config_watches_its_directory_and_its_watch_dir() {
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let app = root.join("app");
        let shared = root.join("shared");
        std::fs::create_dir_all(app.join("src")).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        let config = app.join("wrangler.jsonc");
        // `main` is a source the build reads, not its output: a codegen step.
        std::fs::write(
            &config,
            r#"{"name":"app","main":"src/index.ts",
                "build":{"command":"npm run codegen","watch_dir":["src","../shared"]}}"#,
        )
        .unwrap();
        let console = Console { color: false };
        let plan = WatchPlan::for_configs(std::slice::from_ref(&config), true, &console).unwrap();
        assert_eq!(
            plan.roots,
            [
                WatchRoot {
                    path: app.clone(),
                    base: app.clone(),
                },
                WatchRoot {
                    path: shared.clone(),
                    base: shared.clone(),
                },
            ]
        );
        let relevant = |path: PathBuf| relevant_project_event(&plan, &modified(path), &[]);
        assert!(relevant(app.join("src/index.ts")));
        assert!(relevant(app.join("codegen.yaml")));
        assert!(relevant(shared.join("types.ts")));
        assert!(!relevant(app.join(".wrangler/out.js")));
        assert!(!relevant(shared.join("node_modules/x.js")));

        // `--no-build` runs no build, so `build.watch_dir` is not an input.
        let unbuilt =
            WatchPlan::for_configs(std::slice::from_ref(&config), false, &console).unwrap();
        assert_eq!(unbuilt, WatchPlan::projects(std::slice::from_ref(&app)));
    }

    #[test]
    fn a_config_change_replans_the_watch() {
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let app = root.join("app");
        let shared = root.join("shared");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        let config = app.join("wrangler.jsonc");
        let console = Console { color: false };
        let plan = || WatchPlan::for_configs(std::slice::from_ref(&config), true, &console);
        std::fs::write(&config, r#"{"name":"app","main":"index.js"}"#).unwrap();
        let before = plan().unwrap();
        assert_eq!(before, WatchPlan::projects(std::slice::from_ref(&app)));
        std::fs::write(
            &config,
            r#"{"name":"app","main":"index.js","build":{"command":"make","watch_dir":"../shared"}}"#,
        )
        .unwrap();
        let after = plan().unwrap();
        assert_ne!(after, before);
        assert!(relevant_project_event(
            &after,
            &modified(shared.join("x.ts")),
            &[]
        ));
        // A config that no longer reads fails the plan; the reload keeps the
        // previous watcher then.
        std::fs::write(&config, "{").unwrap();
        assert!(plan().is_err());
    }

    /// The process-wide registry of `celld dev` builds is shared, so the
    /// tests that run one take turns.
    static DEV_BUILD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Start a `celld dev` build whose command runs `command` in the
    /// background and waits; the background process records its pid and
    /// outlives a kill of the shell alone. Returns the build and that pid.
    async fn hung_build(
        root: &Path,
        command: &str,
    ) -> (
        tokio::task::JoinHandle<anyhow::Result<Vec<(PathBuf, deploy::Built)>>>,
        i32,
    ) {
        let directory = root.join("site");
        std::fs::create_dir_all(&directory).unwrap();
        let config = directory.join("wrangler.jsonc");
        std::fs::write(
            &config,
            json!({
                "name": "site",
                "assets": { "directory": "public" },
                "build": { "command": command },
            })
            .to_string(),
        )
        .unwrap();
        let build = spawn_builds(vec![config], false);
        let pid_file = directory.join("child.pid");
        let started = std::time::Instant::now();
        while std::fs::read_to_string(&pid_file).map_or(true, |pid| pid.trim().is_empty()) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the build did not start"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let child = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        (build, child)
    }

    /// Whether `pid` runs: a zombie waiting for init does not.
    fn running(pid: i32) -> bool {
        (unsafe { libc::kill(pid, 0) }) == 0
            && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .is_ok_and(|stat| stat.contains(") Z "))
    }

    async fn stopped_with(
        build: tokio::task::JoinHandle<anyhow::Result<Vec<(PathBuf, deploy::Built)>>>,
    ) -> String {
        let Err(error) = build.await.unwrap() else {
            panic!("a stopped build succeeded");
        };
        format!("{error:#}")
    }

    #[test]
    fn a_hung_build_is_stopped_with_its_process_group() {
        let _turn = DEV_BUILD.lock().unwrap_or_else(|e| e.into_inner());
        host_runtime().block_on(async {
            let root = tempfile::tempdir().unwrap();
            let (build, child) = hung_build(
                root.path(),
                "sh -c 'echo $$ > child.pid; exec sleep 600' & wait",
            )
            .await;
            let stopping = std::time::Instant::now();
            tokio::task::spawn_blocking(|| deploy::stop_builds(Duration::from_secs(2)))
                .await
                .unwrap();
            let error = stopped_with(build).await;
            assert!(stopping.elapsed() < Duration::from_secs(5));
            assert!(error.contains("failed (signal: 15"), "{error}");
            assert!(!running(child), "the build's child {child} survived");
            deploy::reset_builds();
        });
    }

    /// A second signal kills a build that ignores SIGTERM at once, and no
    /// build starts once `celld dev` is stopping.
    #[test]
    fn a_build_that_ignores_sigterm_is_killed_and_no_build_follows() {
        let _turn = DEV_BUILD.lock().unwrap_or_else(|e| e.into_inner());
        host_runtime().block_on(async {
            let root = tempfile::tempdir().unwrap();
            let (build, child) = hung_build(
                root.path(),
                "trap '' TERM; sh -c 'echo $$ > child.pid; exec sleep 600' & wait",
            )
            .await;
            let stopping =
                tokio::task::spawn_blocking(|| deploy::stop_builds(Duration::from_secs(60)));
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(running(child), "SIGTERM is ignored");
            let killing = std::time::Instant::now();
            deploy::kill_builds();
            let error = stopped_with(build).await;
            assert!(killing.elapsed() < Duration::from_secs(2));
            assert!(error.contains("failed (signal: 9"), "{error}");
            stopping.await.unwrap();
            assert!(!running(child), "the build's child {child} survived");

            let config = built_assets_project(root.path());
            let error = stopped_with(spawn_builds(vec![config], false)).await;
            assert_eq!(error, "celld dev is stopping");
            deploy::reset_builds();
        });
    }

    #[test]
    fn a_rebuild_drops_only_rewrites_with_the_same_content() {
        host_runtime().block_on(async {
            let root = tempfile::tempdir().unwrap();
            let root = std::fs::canonicalize(root.path()).unwrap();
            let generated = root.join("generated.js");
            let source = root.join("index.js");
            std::fs::write(&generated, "v1").unwrap();
            std::fs::write(&source, "s1").unwrap();
            let mut watcher =
                ProjectWatcher::new(WatchPlan::projects(std::slice::from_ref(&root)), Vec::new())
                    .unwrap();
            let settle = || tokio::time::sleep(Duration::from_millis(300));
            // Both files changed before the rebuild that records them.
            std::fs::write(&generated, "v2").unwrap();
            std::fs::write(&source, "s2").unwrap();
            settle().await;
            watcher.changed().await.unwrap();
            watcher.snapshot();
            // The build rewrites its output with the same content: dropped.
            std::fs::write(&generated, "v2").unwrap();
            settle().await;
            watcher.discard_unchanged();
            assert!(!watcher.kept);
            // A save during the build is a change: kept.
            watcher.snapshot();
            std::fs::write(&generated, "v2").unwrap();
            std::fs::write(&source, "s3").unwrap();
            settle().await;
            watcher.discard_unchanged();
            assert!(watcher.kept);
            tokio::time::timeout(Duration::from_secs(1), watcher.changed())
                .await
                .expect("a kept change is reported at once")
                .unwrap();
            // A new file has no recorded content, so it counts as a change.
            watcher.snapshot();
            std::fs::write(root.join("new.js"), "n").unwrap();
            settle().await;
            watcher.discard_unchanged();
            assert!(watcher.kept);
        });
    }

    #[test]
    fn celld_dev_runs_the_build_command_unless_no_build() {
        let _turn = DEV_BUILD.lock().unwrap_or_else(|e| e.into_inner());
        host_runtime().block_on(async {
            let root = tempfile::tempdir().unwrap();
            let config = built_assets_project(root.path());
            let store = Store {
                database: root.path().join("objects.sqlite3"),
            };
            let error = deploy_projects(std::slice::from_ref(&config), &store, false, true)
                .await
                .unwrap_err();
            assert!(
                format!("{error:#}").contains("public"),
                "--no-build leaves the assets unbuilt: {error:#}"
            );
            deploy_projects(std::slice::from_ref(&config), &store, false, false)
                .await
                .unwrap();
            assert_eq!(
                std::fs::read_to_string(config.with_file_name("public/index.html")).unwrap(),
                "dev\n"
            );
        });
    }

    #[test]
    fn dotenv_files_stay_with_their_config() {
        let root = tempfile::tempdir().unwrap();
        let front = project(root.path(), "front", &[(".dev.vars", "TOKEN=front\n")]);
        let back = project(
            root.path(),
            "back",
            &[
                (".env", "TOKEN=back\nOTHER=1\n"),
                (".env.local", "OTHER=2\n"),
            ],
        );
        let empty = project(root.path(), "empty", &[]);
        let vars = |directory: &Path| read_dev_vars(&directory.join("wrangler.jsonc")).unwrap();
        let entries = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect::<BTreeMap<_, _>>()
        };
        match vars(&front) {
            deploy::VarOverrides::DevVars(found) => {
                assert_eq!(found, entries(&[("TOKEN", "front")]))
            }
            _ => panic!("front reads its .dev.vars"),
        }
        match vars(&back) {
            deploy::VarOverrides::DotEnv { files: found, .. } => {
                assert_eq!(found, entries(&[("TOKEN", "back"), ("OTHER", "2")]))
            }
            _ => panic!("back reads its dotenv files"),
        }
        match vars(&empty) {
            deploy::VarOverrides::DotEnv { files: found, .. } => assert!(found.is_empty()),
            _ => panic!("a project without files has no overrides"),
        }
    }

    #[test]
    fn the_ready_line_names_connectable_origins() {
        assert_eq!(
            ready_line("127.0.0.1:43210".parse().unwrap(), "http://127.0.0.1:43211").unwrap(),
            r#"{"event":"ready","public":"http://127.0.0.1:43210","internal":"http://127.0.0.1:43211"}"#
        );
        assert_eq!(
            ready_line("0.0.0.0:80".parse().unwrap(), "http://127.0.0.1:1").unwrap(),
            r#"{"event":"ready","public":"http://127.0.0.1:80","internal":"http://127.0.0.1:1"}"#
        );
        assert_eq!(
            ready_line("[::]:80".parse().unwrap(), "http://127.0.0.1:1").unwrap(),
            r#"{"event":"ready","public":"http://[::1]:80","internal":"http://127.0.0.1:1"}"#
        );
    }

    #[test]
    fn the_node_announcements_parse() {
        assert_eq!(
            public_address("celld listening on 127.0.0.1:43210 (ownership=local)"),
            Some("127.0.0.1:43210".parse().unwrap())
        );
        assert_eq!(
            public_address("celld internal listening on 127.0.0.1:1 (advertise=x)"),
            None
        );
        assert_eq!(
            internal_origin("celld internal listening on 127.0.0.1:43211 (advertise=x)"),
            Some("http://127.0.0.1:43211".to_string())
        );
    }

    #[test]
    fn each_directory_is_watched_once() {
        let projects = [
            "/work/app",
            "/work/app/workers/back",
            "/work/other",
            "/work/app",
        ]
        .map(PathBuf::from);
        assert_eq!(watch_roots(&projects), [&projects[0], &projects[2]]);
    }

    #[test]
    fn ignore_rules_follow_the_innermost_project() {
        let outer = PathBuf::from("/work/app");
        let inner = PathBuf::from("/work/app/workers/back");
        let sibling = PathBuf::from("/work/other");
        let projects = WatchPlan::projects(&[outer.clone(), inner.clone(), sibling.clone()]);
        let ignored = [Pattern::new("generated/**").unwrap()];
        let event = |path: PathBuf| {
            notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any))
                .add_path(path)
        };
        let relevant = |path: PathBuf| relevant_project_event(&projects, &event(path), &ignored);
        assert!(relevant(outer.join("src/index.js")));
        assert!(relevant(inner.join("index.js")));
        assert!(relevant(sibling.join("index.js")));
        assert!(!relevant(inner.join("generated/out.js")));
        assert!(!relevant(sibling.join("node_modules/x/index.js")));
        // `generated/**` is relative to the inner project, not the outer one.
        assert!(relevant(outer.join("workers/generated/x.js")));
        assert!(!relevant(outer.join("generated/x.js")));
        let read = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Any))
            .add_path(outer.join("src/index.js"));
        assert!(!relevant_project_event(&projects, &read, &ignored));
    }
}
