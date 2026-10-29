// Copyright 2026 Deno Land Inc. Apache-2.0 license.

// Isolate threads are in the V8 arm outside the Actor execution domain: they
// read the monotonic clock to tell a long turn from a short one.
#![allow(clippy::disallowed_methods)]

//! The threads every isolate turn runs on.
//!
//! JavaScript never runs on the Tokio workers. They serve the public and
//! internal listeners, the Actor and the peer tunnel, and a turn that holds
//! its thread (a long CPU limit, or a builtin that does not stop for a
//! termination) must not take them: enough such turns took every worker, and
//! the node answered nothing, its health probes included (plan 1.61).
//! [`crate::pool::Slot::turn`] queues each turn on its isolate and awaits it
//! through a oneshot; a thread here runs the isolate's turns, so a stuck turn
//! holds an isolate thread and nothing else.
//!
//! **Concurrency.** `core` threads (`CELLD_ISOLATE_THREADS`, the CPU count by
//! default) run turns. A turn that has run for [`LONG_TURN`] no longer counts
//! against them: while work waits and fewer than `core` threads run short
//! work, the pool starts another thread, so long turns cannot starve the
//! short ones of other isolates. Threads that are not stuck number at most
//! `2 × core`; a stuck turn (its isolate condemned while it runs,
//! [`crate::pool::stuck_isolates`]) does not count against that bound,
//! since the stuck caps already bound how many there are. A thread over
//! `core` exits after [`KEEPALIVE`] without work.
//!
//! **Locality.** Work goes to the thread that last ran its isolate when that
//! thread is idle, and otherwise to the thread that went idle last: an
//! isolate that moves between threads pays for V8's thread switch and cold
//! caches, and a thread that has slept longest wakes slowest. Measured, a
//! FIFO hand-off to any idle thread cost a plain fetch about 8%.
//!
//! **Tokio context.** Each thread enters the host runtime, so a turn can
//! spawn tasks, arm timers and read `Handle::current()` as it could on a
//! worker. A turn cannot `block_in_place`; none does.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

/// How long work runs before it no longer counts as one of the `core`
/// running turns, and waiting work may get a thread of its own.
pub(crate) const LONG_TURN: Duration = Duration::from_millis(50);

/// How often the monitor looks again while work waits and every thread is
/// busy.
const MONITOR_TICK: Duration = Duration::from_millis(10);

/// How long a thread over `core` waits for work before it exits.
const KEEPALIVE: Duration = Duration::from_secs(10);

/// Work for an isolate thread: a closure, or a task to poll. A task's wakeup
/// queues the task itself, with no allocation.
pub(crate) enum Job {
    Run(Box<dyn FnOnce() + Send>),
    Poll(Arc<Task>),
}

impl Job {
    fn execute(self) {
        match self {
            Job::Run(run) => run(),
            Job::Poll(task) => Task::run(task),
        }
    }
}

static THREADS: OnceLock<IsolateThreads> = OnceLock::new();

thread_local! {
    /// This isolate thread's number, or `None` on any other thread.
    static THREAD_NUMBER: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Start the node's isolate threads: from now on every turn runs on them.
/// Called once, by the node, before any Worker loads. Without it (unit tests,
/// the CLI's tools) a turn runs on the thread that awaits it.
pub fn install(handle: tokio::runtime::Handle, core: usize) -> anyhow::Result<()> {
    anyhow::ensure!(core > 0, "isolate threads: at least one is needed");
    let threads = IsolateThreads::start(handle, core)?;
    THREADS
        .set(threads)
        .map_err(|_| anyhow::anyhow!("isolate threads are already installed"))
}

/// The thread count `install` takes when `CELLD_ISOLATE_THREADS` is unset.
pub fn default_core() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(4)
}

pub(crate) fn installed() -> Option<&'static IsolateThreads> {
    THREADS.get()
}

/// The number of the isolate thread running this, if one is.
pub(crate) fn current_thread() -> Option<u64> {
    THREAD_NUMBER.get()
}

/// Run `work`, which enters V8, on an isolate thread when the node has them,
/// and on the execution facade's blocking pool otherwise; a panic comes back as an error.
/// For a load or a placement, which builds an isolate outside any turn.
pub async fn offload<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> anyhow::Result<T> {
    match installed() {
        Some(threads) => match threads.run_catching(work).await {
            Ok(value) => Ok(value),
            Err(panic) => Err(anyhow::anyhow!("panicked: {}", panic_text(&*panic))),
        },
        None => crate::asyncrt::blocking(work)
            .await
            .map_err(|error| anyhow::anyhow!("{error}")),
    }
}

pub(crate) fn panic_text(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|text| text.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic with no message".to_string())
}

/// Run `future`, the driver of an event of `owner`'s, as a task on the
/// isolate threads, so the turns it takes run where it is polled, with no
/// hand-off between threads; first polled on the isolate thread `near` when
/// it is idle, the one that last ran the isolate its first turn goes to. Its
/// polls count as `owner`'s work for the reserve threads. Without isolate
/// threads it is an `asyncrt` task. Like a Tokio task it runs to its end
/// whether or not the handle is awaited.
pub(crate) fn spawn_near<T: Send + 'static>(
    near: Option<u64>,
    owner: Option<Arc<crate::turn_owner::Owner>>,
    future: impl std::future::Future<Output = T> + Send + 'static,
) -> Driving<T> {
    match installed() {
        Some(threads) => threads.spawn(near, owner, future),
        // The execution facade's task, which a simulated runtime schedules.
        None => Driving(DrivingInner::Task(crate::asyncrt::spawn(future))),
    }
}

impl IsolateThreads {
    fn spawn<T: Send + 'static>(
        &self,
        near: Option<u64>,
        owner: Option<Arc<crate::turn_owner::Owner>>,
        future: impl std::future::Future<Output = T> + Send + 'static,
    ) -> Driving<T> {
        let (send, receive) = tokio::sync::oneshot::channel();
        let future = async move {
            let result =
                futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(future)).await;
            if let Err(Err(panic)) = send.send(result) {
                tracing::error!(
                    event = "isolate_task_panicked",
                    panic = %panic_text(&*panic),
                    "a task nobody awaits panicked"
                );
            }
        };
        let task = Arc::new(Task {
            state: std::sync::atomic::AtomicU8::new(TASK_SCHEDULED),
            future: Mutex::new(Some(Box::pin(future))),
            last_thread: std::sync::atomic::AtomicU64::new(0),
            threads: self.shared.clone(),
            owner,
        });
        let owner = task.owner.clone();
        self.shared.submit_owned(
            Job::Poll(task),
            near.or_else(current_thread),
            owner.as_deref(),
        );
        Driving(DrivingInner::Isolate(receive))
    }
}

/// A task [`spawn_near`] started; awaiting it gives its output, or why it died.
pub struct Driving<T>(DrivingInner<T>);

enum DrivingInner<T> {
    Isolate(tokio::sync::oneshot::Receiver<std::thread::Result<T>>),
    Task(crate::asyncrt::TaskHandle<T>),
}

/// A task that panicked, or was dropped before it ended.
#[derive(Debug)]
pub struct TaskDied(String);

impl std::fmt::Display for TaskDied {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for TaskDied {}

impl<T> std::future::Future for Driving<T> {
    type Output = Result<T, TaskDied>;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        match &mut self.get_mut().0 {
            DrivingInner::Isolate(receive) => {
                std::pin::Pin::new(receive)
                    .poll(context)
                    .map(|result| match result {
                        Ok(Ok(value)) => Ok(value),
                        Ok(Err(panic)) => {
                            Err(TaskDied(format!("task panicked: {}", panic_text(&*panic))))
                        }
                        Err(_) => Err(TaskDied("task dropped before it ended".to_string())),
                    })
            }
            DrivingInner::Task(handle) => std::pin::Pin::new(handle)
                .poll(context)
                .map(|result| result.map_err(|error| TaskDied(error.to_string()))),
        }
    }
}

const TASK_IDLE: u8 = 0;
const TASK_SCHEDULED: u8 = 1;
const TASK_RUNNING: u8 = 2;
/// Woken while it ran: it is polled again before the thread lets it go.
const TASK_NOTIFIED: u8 = 3;
const TASK_DONE: u8 = 4;

/// How many times a task woken while it ran is polled again in a row before
/// it goes to the back of the queue.
const TASK_POLL_BUDGET: usize = 16;

/// A future [`spawn_near`] runs, polled on whichever isolate thread its wakeup
/// lands on, preferring the one that polled it last.
pub(crate) struct Task {
    state: std::sync::atomic::AtomicU8,
    future: Mutex<Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>>>,
    /// The isolate thread that polled it last, plus one; 0 for none.
    last_thread: std::sync::atomic::AtomicU64,
    threads: Arc<Shared>,
    /// The owner of the isolate it drives, for the reserve threads.
    owner: Option<Arc<crate::turn_owner::Owner>>,
}

impl std::task::Wake for Task {
    fn wake(self: Arc<Self>) {
        Task::schedule(self);
    }

    fn wake_by_ref(self: &Arc<Self>) {
        Task::schedule(self.clone());
    }
}

impl Task {
    fn schedule(task: Arc<Self>) {
        use std::sync::atomic::Ordering;
        let mut state = task.state.load(Ordering::Acquire);
        loop {
            let next = match state {
                TASK_IDLE => TASK_SCHEDULED,
                TASK_RUNNING => TASK_NOTIFIED,
                _ => return,
            };
            match task
                .state
                .compare_exchange(state, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) if next == TASK_SCHEDULED => {
                    let prefer = task.last_thread.load(Ordering::Relaxed).checked_sub(1);
                    let threads = task.threads.clone();
                    let owner = task.owner.clone();
                    threads.submit_owned(Job::Poll(task), prefer, owner.as_deref());
                    return;
                }
                Ok(_) => return,
                Err(actual) => state = actual,
            }
        }
    }

    fn run(task: Arc<Self>) {
        use std::sync::atomic::Ordering;
        task.state.store(TASK_RUNNING, Ordering::Release);
        if let Some(thread) = current_thread() {
            task.last_thread.store(thread + 1, Ordering::Relaxed);
        }
        let waker = std::task::Waker::from(task.clone());
        let mut context = std::task::Context::from_waker(&waker);
        for _ in 0..TASK_POLL_BUDGET {
            {
                let mut future = task
                    .future
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(polled) = future.as_mut() else {
                    task.state.store(TASK_DONE, Ordering::Release);
                    return;
                };
                // The future catches its own panics (`spawn_near`); this catches
                // one in dropping it, so the task ends rather than staying
                // marked as running.
                let ready = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    polled.as_mut().poll(&mut context).is_ready()
                }));
                if !matches!(ready, Ok(false)) {
                    let taken = future.take();
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(taken)))
                        .is_err()
                        || ready.is_err()
                    {
                        tracing::error!(
                            event = "isolate_task_panicked",
                            "an isolate task panicked outside its own catch"
                        );
                    }
                    task.state.store(TASK_DONE, Ordering::Release);
                    return;
                }
            }
            if task
                .state
                .compare_exchange(TASK_RUNNING, TASK_IDLE, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return;
            }
            // Woken while it ran: poll again.
            task.state.store(TASK_RUNNING, Ordering::Release);
        }
        task.state.store(TASK_SCHEDULED, Ordering::Release);
        let threads = task.threads.clone();
        let owner = task.owner.clone();
        threads.submit_owned(Job::Poll(task), None, owner.as_deref());
    }
}

/// What `/state` reports of the isolate threads.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCensus {
    /// The threads that run turns before any is long.
    pub core: usize,
    /// The most threads that are not stuck.
    pub max: usize,
    /// Threads alive now.
    pub threads: usize,
    /// Threads waiting for work.
    pub idle: usize,
    /// Threads running work that began [`LONG_TURN`] ago or more.
    pub long: usize,
    /// Work waiting for a thread.
    pub queued: usize,
}

pub(crate) struct IsolateThreads {
    shared: Arc<Shared>,
}

struct Shared {
    core: usize,
    max: usize,
    /// The most threads at all, stuck ones included: past it, work waits.
    hard: usize,
    /// Threads past `hard` that only clean owners' work may use, so a
    /// well-behaved Worker makes progress however many others are stuck.
    reserve: usize,
    handle: tokio::runtime::Handle,
    state: Mutex<State>,
    /// The monitor waits here for work that finds no thread.
    monitor: Condvar,
}

#[derive(Default)]
struct State {
    /// Work no idle thread took.
    queue: VecDeque<Job>,
    /// Work of clean owners (no stuck or long turn) that came at the hard
    /// ceiling, for the reserve threads.
    clean: VecDeque<Job>,
    /// Reserve threads alive, and those idle.
    reserve_threads: usize,
    reserve_idle: Vec<u64>,
    threads: usize,
    /// Idle threads, the one that went idle last at the end.
    idle: Vec<u64>,
    /// Work handed to an idle thread, which takes it when it wakes.
    handed: HashMap<u64, Job>,
    /// Each thread's wakeup.
    wakes: HashMap<u64, Arc<Condvar>>,
    /// When each busy thread's work began, by thread number.
    busy: HashMap<u64, Instant>,
    next_thread: u64,
    /// Threads started that have not yet looked for work: queued work is
    /// theirs, so they count as busy with short work.
    starting: usize,
    /// The monitor waits with no deadline, so work that finds no thread
    /// must wake it.
    monitor_parked: bool,
}

/// What the pool decides when work finds no idle thread.
#[derive(Debug, PartialEq, Eq)]
enum Shortfall {
    /// Start a thread for it.
    Grow,
    /// Wait for a thread, and look again in a while: the busy threads may
    /// become long.
    Wait,
}

/// The most isolate threads: `2 × core` that are not stuck, and as many
/// stuck as the node-wide cap allows (`turn_owner::stuck_node_cap`).
fn hard_ceiling(core: usize) -> usize {
    core.saturating_mul(2) + (core / 2).max(crate::turn_owner::STUCK_PER_OWNER + 1)
}

/// Whether waiting work gets a new thread: while fewer than `core` threads
/// run short work, the threads that are not stuck stay within `max`, and all
/// of them within `hard`.
fn shortfall(
    core: usize,
    max: usize,
    hard: usize,
    threads: usize,
    short: usize,
    stuck: usize,
) -> Shortfall {
    let unstuck = threads.saturating_sub(stuck);
    if threads < hard && (threads < core || (short < core && unstuck < max)) {
        Shortfall::Grow
    } else {
        Shortfall::Wait
    }
}

impl State {
    fn short_turns(&self, now: Instant) -> usize {
        self.starting
            + self
                .busy
                .values()
                .filter(|started| now.saturating_duration_since(**started) < LONG_TURN)
                .count()
    }

    /// Hand `job` to `thread`, which must be idle; the caller wakes it with
    /// the condvar returned, once it has let the lock go, so the thread does
    /// not wake into a held lock.
    fn hand(&mut self, thread: u64, job: Job) -> Option<Arc<Condvar>> {
        self.handed.insert(thread, job);
        self.wakes.get(&thread).cloned()
    }
}

impl IsolateThreads {
    fn start(handle: tokio::runtime::Handle, core: usize) -> anyhow::Result<Self> {
        let shared = Arc::new(Shared {
            core,
            max: core.saturating_mul(2),
            hard: hard_ceiling(core),
            reserve: (core / 2).max(2),
            handle,
            state: Mutex::new(State::default()),
            monitor: Condvar::new(),
        });
        let monitor = shared.clone();
        std::thread::Builder::new()
            .name("celld-isolate-monitor".to_string())
            .spawn(move || monitor.run_monitor())
            .map_err(|error| anyhow::anyhow!("isolate threads: start the monitor: {error}"))?;
        Ok(Self { shared })
    }

    /// The threads that run work before any is long.
    pub(crate) fn core(&self) -> usize {
        self.shared.core
    }

    /// Queue `job`, the work of `owner`, for an isolate thread: `prefer`,
    /// when it is idle. A clean owner's work may use the reserve threads.
    pub(crate) fn submit_for(
        &self,
        job: Box<dyn FnOnce() + Send>,
        prefer: Option<u64>,
        owner: Option<&crate::turn_owner::Owner>,
    ) {
        self.shared.submit_owned(Job::Run(job), prefer, owner);
    }

    /// Run `job` on an isolate thread and wait for its result; a panic in
    /// `job` comes back as the error. The job is queued at this call, not at
    /// the first poll.
    ///
    /// Dropping the future before the job starts means it never runs, and
    /// `job` is dropped on the isolate thread; once it has started it runs
    /// to its end, and its result is dropped there.
    fn run_catching<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> impl std::future::Future<Output = std::thread::Result<T>> + Send + 'static {
        let (send, receive) = tokio::sync::oneshot::channel();
        self.shared.submit_job(
            Job::Run(Box::new(move || {
                if send.is_closed() {
                    return;
                }
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                if let Err(Err(panic)) = send.send(result) {
                    tracing::error!(
                        event = "isolate_job_panicked",
                        panic = %panic_text(&*panic),
                        "a job whose caller left panicked"
                    );
                }
            })),
            None,
        );
        async move {
            receive
                .await
                .expect("an isolate thread dropped a job without running it")
        }
    }

    pub(crate) fn census(&self) -> ThreadCensus {
        let state = self.shared.state.lock().expect("isolate threads poisoned");
        let now = Instant::now();
        ThreadCensus {
            core: self.shared.core,
            max: self.shared.max,
            threads: state.threads,
            idle: state.idle.len(),
            long: (state.busy.len() + state.starting) - state.short_turns(now),
            queued: state.queue.len(),
        }
    }
}

/// The census of the node's isolate threads, `None` when they run inline.
pub fn census() -> Option<ThreadCensus> {
    installed().map(IsolateThreads::census)
}

impl Shared {
    fn submit_job(self: &Arc<Self>, job: Job, prefer: Option<u64>) {
        self.submit_owned(job, prefer, None);
    }

    /// Queue `job`, the work of `owner`: an idle thread takes it, or a new
    /// one; at the hard ceiling only a clean owner's work gets a reserve
    /// thread, and the rest waits.
    fn submit_owned(
        self: &Arc<Self>,
        job: Job,
        prefer: Option<u64>,
        owner: Option<&crate::turn_owner::Owner>,
    ) {
        let mut state = self.state.lock().expect("isolate threads poisoned");
        let preferred =
            prefer.and_then(|thread| state.idle.iter().position(|idle| *idle == thread));
        let idle = match preferred {
            Some(index) => Some(state.idle.remove(index)),
            None => state.idle.pop(),
        };
        if let Some(thread) = idle {
            let wake = state.hand(thread, job);
            drop(state);
            if let Some(wake) = wake {
                wake.notify_one();
            }
            return;
        }
        let short = state.short_turns(Instant::now());
        let stuck = crate::pool::stuck_isolates();
        // Long and stuck turns hold every thread the ceilings allow: a
        // clean owner's work takes a reserve thread instead of waiting.
        let at_ceiling = short < self.core
            && (state.threads >= self.hard || state.threads.saturating_sub(stuck) >= self.max);
        if at_ceiling && owner.is_some_and(crate::turn_owner::Owner::is_clean) {
            if let Some(thread) = state.reserve_idle.pop() {
                let wake = state.hand(thread, job);
                drop(state);
                if let Some(wake) = wake {
                    wake.notify_one();
                }
                return;
            }
            state.clean.push_back(job);
            if state.reserve_threads < self.reserve {
                let spawn = self.reserve_thread(&mut state, true);
                drop(state);
                self.spawn_thread(spawn);
            }
            return;
        }
        state.queue.push_back(job);
        match shortfall(self.core, self.max, self.hard, state.threads, short, stuck) {
            Shortfall::Grow => {
                let spawn = self.reserve_thread(&mut state, false);
                drop(state);
                self.spawn_thread(spawn);
            }
            Shortfall::Wait => self.wake_monitor(&mut state),
        }
    }

    fn wake_monitor(&self, state: &mut State) {
        if state.monitor_parked {
            state.monitor_parked = false;
            self.monitor.notify_one();
        }
    }

    /// Count a thread about to start, under the state lock; the caller
    /// starts it with [`Shared::spawn_thread`] once the lock is let go. A
    /// `reserve` thread takes only clean owners' work.
    fn reserve_thread(&self, state: &mut State, reserve: bool) -> (u64, Arc<Condvar>, bool) {
        let number = state.next_thread;
        let wake = Arc::new(Condvar::new());
        state.next_thread += 1;
        if reserve {
            state.reserve_threads += 1;
        } else {
            state.threads += 1;
            state.starting += 1;
        }
        state.wakes.insert(number, wake.clone());
        (number, wake, reserve)
    }

    /// Start a reserved thread, outside the lock. A failure (a thread limit)
    /// is logged and left to the monitor, which tries again while work waits.
    fn spawn_thread(self: &Arc<Self>, (number, wake, reserve): (u64, Arc<Condvar>, bool)) {
        let shared = self.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("celld-isolate-{number}"))
            .spawn(move || {
                if reserve {
                    shared.run_reserve_thread(number, &wake)
                } else {
                    shared.run_thread(number, &wake)
                }
            });
        if let Err(error) = spawned {
            let mut state = self.state.lock().expect("isolate threads poisoned");
            if reserve {
                state.reserve_threads -= 1;
            } else {
                state.threads -= 1;
                state.starting -= 1;
            }
            state.wakes.remove(&number);
            tracing::error!(
                event = "isolate_thread_spawn_failed",
                %error,
                threads = state.threads,
                "an isolate thread did not start; turns wait for a busy one"
            );
            self.wake_monitor(&mut state);
        }
    }

    /// A reserve thread: clean owners' work only, and it exits after
    /// [`KEEPALIVE`] without any.
    fn run_reserve_thread(self: Arc<Self>, number: u64, wake: &Condvar) {
        let _runtime = self.handle.enter();
        THREAD_NUMBER.set(Some(number));
        let mut state = self.state.lock().expect("isolate threads poisoned");
        loop {
            let job = state
                .handed
                .remove(&number)
                .or_else(|| state.clean.pop_front());
            let Some(job) = job else {
                state.reserve_idle.push(number);
                let (next, wait) = wake
                    .wait_timeout(state, KEEPALIVE)
                    .expect("isolate threads poisoned");
                state = next;
                if let Some(index) = state.reserve_idle.iter().position(|idle| *idle == number) {
                    state.reserve_idle.remove(index);
                    if wait.timed_out() && state.clean.is_empty() {
                        state.reserve_threads -= 1;
                        state.wakes.remove(&number);
                        return;
                    }
                }
                continue;
            };
            drop(state);
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job.execute())).is_err() {
                tracing::error!(event = "isolate_job_panicked", "an isolate job panicked");
            }
            state = self.state.lock().expect("isolate threads poisoned");
        }
    }

    fn run_thread(self: Arc<Self>, number: u64, wake: &Condvar) {
        let _runtime = self.handle.enter();
        THREAD_NUMBER.set(Some(number));
        let mut state = self.state.lock().expect("isolate threads poisoned");
        state.starting -= 1;
        loop {
            let job = state
                .handed
                .remove(&number)
                .or_else(|| state.queue.pop_front())
                .or_else(|| state.clean.pop_front());
            let Some(job) = job else {
                state.idle.push(number);
                let extra = state.threads > self.core;
                let (next, timed_out) = if extra {
                    let (next, wait) = wake
                        .wait_timeout(state, KEEPALIVE)
                        .expect("isolate threads poisoned");
                    (next, wait.timed_out())
                } else {
                    (wake.wait(state).expect("isolate threads poisoned"), false)
                };
                state = next;
                // Still listed as idle, so nothing was handed to it: a
                // spurious wakeup, or time for a thread over `core` to go.
                if let Some(index) = state.idle.iter().position(|idle| *idle == number) {
                    if timed_out && state.queue.is_empty() && state.threads > self.core {
                        state.idle.remove(index);
                        state.threads -= 1;
                        state.wakes.remove(&number);
                        return;
                    }
                    state.idle.remove(index);
                }
                continue;
            };
            state.busy.insert(number, Instant::now());
            drop(state);
            // A job catches its own panic and hands it to its caller; this
            // only keeps the thread if a drop in the job panics.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job.execute())).is_err() {
                tracing::error!(event = "isolate_job_panicked", "an isolate job panicked");
            }
            state = self.state.lock().expect("isolate threads poisoned");
            state.busy.remove(&number);
        }
    }

    fn run_monitor(self: Arc<Self>) {
        let mut state = self.state.lock().expect("isolate threads poisoned");
        loop {
            if state.queue.is_empty() {
                state.monitor_parked = true;
                state = self.monitor.wait(state).expect("isolate threads poisoned");
                continue;
            }
            // An idle thread takes queued work before a new one starts.
            if let Some(thread) = state.idle.pop() {
                let job = state.queue.pop_front().expect("checked above");
                if let Some(wake) = state.hand(thread, job) {
                    wake.notify_one();
                }
                continue;
            }
            let short = state.short_turns(Instant::now());
            if shortfall(
                self.core,
                self.max,
                self.hard,
                state.threads,
                short,
                crate::pool::stuck_isolates(),
            ) == Shortfall::Grow
            {
                let spawn = self.reserve_thread(&mut state, false);
                drop(state);
                self.spawn_thread(spawn);
                state = self.state.lock().expect("isolate threads poisoned");
            }
            state.monitor_parked = false;
            state = self
                .monitor
                .wait_timeout(state, MONITOR_TICK)
                .expect("isolate threads poisoned")
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_work_gets_a_thread_while_few_run_short() {
        // Under `core` threads: always.
        assert_eq!(shortfall(4, 8, 14, 3, 3, 0), Shortfall::Grow);
        // Every thread runs short work: wait for one.
        assert_eq!(shortfall(4, 8, 14, 4, 4, 0), Shortfall::Wait);
        // Long turns leave room for short ones, up to `max`.
        assert_eq!(shortfall(4, 8, 14, 6, 2, 0), Shortfall::Grow);
        assert_eq!(shortfall(4, 8, 14, 8, 0, 0), Shortfall::Wait);
        // Stuck turns do not count against `max`.
        assert_eq!(shortfall(4, 8, 14, 10, 0, 3), Shortfall::Grow);
        assert_eq!(shortfall(4, 8, 14, 11, 0, 3), Shortfall::Wait);
        // Never past the hard ceiling, however many are stuck.
        assert_eq!(shortfall(4, 8, 14, 14, 0, 10), Shortfall::Wait);
        assert_eq!(hard_ceiling(4), 11);
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Work runs on the pool's threads, inside the host runtime, and long
    /// work does not hold back the next: the pool grows past `core`.
    #[test]
    fn long_work_does_not_hold_back_short_work() {
        let runtime = runtime();
        let threads = IsolateThreads::start(runtime.handle().clone(), 1).unwrap();
        runtime.block_on(async {
            let caller = std::thread::current().id();
            let (ran_on, in_runtime, number) = threads
                .run_catching(|| {
                    (
                        std::thread::current().id(),
                        tokio::runtime::Handle::try_current().is_ok(),
                        current_thread(),
                    )
                })
                .await
                .unwrap();
            assert_ne!(ran_on, caller);
            assert!(in_runtime);
            assert!(number.is_some());
            assert_eq!(current_thread(), None);

            let (release, hold) = std::sync::mpsc::channel::<()>();
            let long = tokio::spawn(threads.run_catching(move || {
                hold.recv_timeout(Duration::from_secs(10)).ok();
            }));
            tokio::time::sleep(LONG_TURN * 2).await;
            let started = Instant::now();
            let short = tokio::time::timeout(Duration::from_secs(5), threads.run_catching(|| 7))
                .await
                .expect("the short work waited for the long work");
            assert_eq!(short.unwrap(), 7);
            assert!(started.elapsed() < Duration::from_secs(1));
            assert_eq!(threads.census().long, 1);
            release.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), long)
                .await
                .expect("the long work ended")
                .unwrap()
                .unwrap();
        });
    }

    /// Work goes back to the idle thread it asks for.
    #[test]
    fn work_prefers_the_thread_it_names() {
        let runtime = runtime();
        let threads = IsolateThreads::start(runtime.handle().clone(), 4).unwrap();
        runtime.block_on(async {
            // Start four threads, each held until all have started.
            let barrier = Arc::new(std::sync::Barrier::new(4));
            let started: Vec<_> = (0..4)
                .map(|_| {
                    let barrier = barrier.clone();
                    tokio::spawn(threads.run_catching(move || {
                        barrier.wait();
                        current_thread().unwrap()
                    }))
                })
                .collect();
            let mut numbers = Vec::new();
            for started in started {
                numbers.push(
                    tokio::time::timeout(Duration::from_secs(5), started)
                        .await
                        .unwrap()
                        .unwrap()
                        .unwrap(),
                );
            }
            // Let all four go idle.
            for _ in 0..500 {
                if threads.census().idle == 4 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(threads.census().idle, 4);
            // A burst starts no more threads than it can use.
            assert_eq!(threads.census().threads, 4);
            for number in numbers {
                let (send, receive) = tokio::sync::oneshot::channel();
                threads.submit_for(
                    Box::new(move || {
                        let _ = send.send(current_thread());
                    }),
                    Some(number),
                    None,
                );
                let ran_on = tokio::time::timeout(Duration::from_secs(5), receive)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(ran_on, Some(number));
            }
        });
    }

    /// A task runs on the isolate threads, is polled again when what it
    /// awaits wakes it, and reports a panic.
    #[test]
    fn a_task_runs_on_the_isolate_threads() {
        let runtime = runtime();
        let threads = IsolateThreads::start(runtime.handle().clone(), 2).unwrap();
        runtime.block_on(async {
            let (send, receive) = tokio::sync::oneshot::channel::<u32>();
            let task = threads.spawn(None, None, async move {
                let before = current_thread();
                // Woken from the Tokio side, after a timer of its own.
                tokio::time::sleep(Duration::from_millis(20)).await;
                let value = receive.await.unwrap();
                (before.is_some(), current_thread().is_some(), value)
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            send.send(7).unwrap();
            let ran = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("the task ended")
                .unwrap();
            assert_eq!(ran, (true, true, 7));
            let died = threads.spawn(None, None, async { panic!("in a task") });
            let error = tokio::time::timeout(Duration::from_secs(5), died)
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.to_string(), "task panicked: in a task");
            // Many wakeups while it runs are not lost.
            let (tick, mut ticks) = tokio::sync::mpsc::unbounded_channel::<u32>();
            let counted = threads.spawn(None, None, async move {
                let mut sum = 0;
                while let Some(value) = ticks.recv().await {
                    sum += value;
                }
                sum
            });
            for value in 0..1000 {
                tick.send(value).unwrap();
            }
            drop(tick);
            let sum = tokio::time::timeout(Duration::from_secs(5), counted)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(sum, (0..1000).sum::<u32>());
        });
    }

    /// With every thread the ceilings allow held by long work, a clean
    /// owner's work runs on a reserve thread, and an owner with a stuck turn
    /// waits.
    #[test]
    fn a_clean_owner_gets_a_reserve_thread_at_the_ceiling() {
        let runtime = runtime();
        let threads = IsolateThreads::start(runtime.handle().clone(), 1).unwrap();
        let clean = crate::turn_owner::owner("reserve-clean");
        let stuck = crate::turn_owner::owner("reserve-stuck");
        stuck.set_stuck_for_test(1);
        runtime.block_on(async {
            // Two long jobs: `max` for one core.
            let (release, hold) = std::sync::mpsc::channel::<()>();
            let hold = Arc::new(Mutex::new(hold));
            for _ in 0..2 {
                let hold = hold.clone();
                threads.submit_for(
                    Box::new(move || {
                        let _ = hold.lock().unwrap().recv_timeout(Duration::from_secs(10));
                    }),
                    None,
                    None,
                );
                tokio::time::sleep(LONG_TURN * 2).await;
            }
            assert_eq!(threads.census().threads, 2);
            let ran = |owner: &Arc<crate::turn_owner::Owner>| {
                let (send, receive) = tokio::sync::oneshot::channel();
                threads.submit_for(
                    Box::new(move || {
                        let _ = send.send(());
                    }),
                    None,
                    Some(owner),
                );
                receive
            };
            let blocked = ran(&stuck);
            tokio::time::timeout(Duration::from_secs(5), ran(&clean))
                .await
                .expect("a clean owner's work waited at the ceiling")
                .unwrap();
            assert_eq!(
                threads.census().threads,
                2,
                "the reserve is not a normal thread"
            );
            let mut blocked = std::pin::pin!(blocked);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), &mut blocked)
                    .await
                    .is_err(),
                "an owner with a stuck turn took a reserve thread"
            );
            for _ in 0..2 {
                release.send(()).unwrap();
            }
            tokio::time::timeout(Duration::from_secs(5), blocked)
                .await
                .expect("the waiting work ran once a thread freed")
                .unwrap();
        });
        stuck.set_stuck_for_test(0);
    }

    /// A panic reaches the caller, and the thread lives on.
    #[test]
    fn a_panic_reaches_the_caller() {
        let runtime = runtime();
        let threads = IsolateThreads::start(runtime.handle().clone(), 1).unwrap();
        runtime.block_on(async {
            let panicked = threads.run_catching(|| panic!("in a job")).await;
            assert_eq!(panic_text(&*panicked.unwrap_err()), "in a job");
            assert_eq!(threads.run_catching(|| 1).await.unwrap(), 1);
        });
    }

    /// Work whose caller left before it started never runs.
    #[test]
    fn cancelled_work_does_not_start() {
        let runtime = runtime();
        let threads = IsolateThreads::start(runtime.handle().clone(), 1).unwrap();
        runtime.block_on(async {
            let (release, hold) = std::sync::mpsc::channel::<()>();
            let busy = tokio::spawn(threads.run_catching(move || {
                hold.recv_timeout(Duration::from_secs(10)).ok();
            }));
            tokio::time::sleep(Duration::from_millis(10)).await;
            let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = ran.clone();
            // Queued behind the busy work at this call, then dropped.
            drop(
                threads.run_catching(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)),
            );
            release.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), busy)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(threads.run_catching(|| 2).await.unwrap(), 2);
            assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        });
    }
}
