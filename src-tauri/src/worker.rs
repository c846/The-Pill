//! One background thread runs every Windows request in order.
//!
//! Requests stay off the UI thread, COM is set up once, and two requests can never finish out of order
//! (a dragged volume slider always ends on the last level it sent).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, OnceLock};

type Job = Box<dyn FnOnce() + Send + 'static>;

static SENDER: OnceLock<mpsc::Sender<Job>> = OnceLock::new();

pub fn start() {
    let (sender, receiver) = mpsc::channel::<Job>();
    if SENDER.set(sender).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("pill-worker".into())
        .spawn(move || {
            crate::util::init_com();
            // The thread sleeps here until a request arrives.
            for job in receiver {
                if catch_unwind(AssertUnwindSafe(job)).is_err() {
                    eprintln!("A Windows request crashed; the pill carries on.");
                }
            }
        })
        .expect("could not start the pill's worker thread");
}

/// Queues work without waiting for it.
pub fn submit(job: impl FnOnce() + Send + 'static) {
    match SENDER.get() {
        Some(sender) => {
            let _ = sender.send(Box::new(job));
        }
        None => eprintln!("The pill's worker thread is not running."),
    }
}

/// Queues work and waits for its result.
pub async fn call<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    submit(move || {
        let _ = sender.send(job());
    });
    receiver
        .await
        .map_err(|_| "The Windows request did not finish.".to_string())?
}
