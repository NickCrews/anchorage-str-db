"""One request budget for the whole run, because Airbnb keeps one for us.

## What was measured

Airbnb (really Akamai, in front of it) counts *requests per IP over a rolling
window* and stops caring how fast you got there. Three separate trips, all
against `www.airbnb.com/rooms/`:

    ~17 req/s  ->  refused after ~133 requests  (~8s in)
    ~17 req/s  ->  refused after ~130 requests  (~8s in)
      4 req/s  ->  stalled  after ~129 requests (~32.5s in)

A stable count across a 4x spread in elapsed time is the signature of a
request counter, not a rate limiter. The threshold is ~130. The window is
longer than 32.5s (the 4/s trip proves it) and shorter than ~104s (or the
old 1.25/s pacing would have been tripping all along), so ~60s fits every
observation and puts the sustainable rate near **2.2/s**.

Measured directly: 1400 requests at a held 2.0/s ran 11.7 minutes with zero
429s. That is the calibration `config.REQUESTS_PER_SECOND` is set from.

## There are two different punishments

**Mild overage stalls you.** At 4/s the limiter stopped answering rather
than refusing: connections hung until every worker sat in a timeout and
throughput sagged to ~1.8/s, without a single 429. Nothing in a success
count can see that — it looks like Airbnb got slow. It shows up as rising
latency, which is why `note_timeout` treats a run of timeouts as a signal
to back off rather than as bad luck.

**Gross overage bans you for hours.** The 17/s burst earned a block that was
still refusing 32.6 minutes later and cleared somewhere around 70 minutes
after that — call it 1-2 hours, IP-wide. While it lasts *everything* on
`www.airbnb.com` is refused: the homepage, the PDP, and the GraphQL calendar
endpoint alike. That is why the budget here is global rather than per-pass
(see `Pacer`), and why a 429 aborts the run instead of retrying (see
`RateLimited`).

## Why this replaces the old per-pass sleep

Each pass used to pace itself by sleeping in its own submit loop:

    for room_id in room_ids:
        time.sleep(random.uniform(MIN_DELAY_S, MAX_DELAY_S))
        pool.submit(fetch_one, room_id)

That sleep ran serially on one thread between submissions, so the pass rate
was `1/mean(delay)` no matter what `*_CONCURRENCY` was set to — raising the
worker count changed nothing at all, and the only way to go faster was to
shorten the sleep, which removed the pacing rather than raising it. Worse,
each pass budgeted separately while Airbnb was counting them together.

Here the rate is one number in requests/second, shared by the search, the
page pass and the calendar pass; `*_CONCURRENCY` goes back to meaning only
"how many sockets may be open at once".
"""

from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)


class RateLimited(RuntimeError):
    """Airbnb returned 429. The run should stop, not retry.

    Retrying is the wrong instinct here and the old code had it: three
    attempts with `time.sleep(0.5 * attempt)` spend 1.5 seconds against a
    block measured in *hours*. All three fail, the listing is recorded as a
    failed fetch, and the next listing begins the same doomed sequence —
    2600 times, while still knocking on an endpoint that is refusing us and
    may well be counting the refusals.

    A run that stops at the first 429 keeps two things the grinding version
    throws away: a clear error naming the real cause, and an IP that is not
    being hammered while it is trying to cool off.
    """


class TokenBucket:
    """Requests per second, shared across threads. `acquire()` blocks."""

    def __init__(self, rate: float, burst: float = 2.0):
        self._rate = max(rate, 0.01)
        # A small burst absorbs ordinary jitter without meaningfully moving
        # the rolling-window count that Airbnb is actually keeping.
        self._burst = max(burst, 1.0)
        self._tokens = self._burst
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    @property
    def rate(self) -> float:
        with self._lock:
            return self._rate

    def set_rate(self, rate: float) -> None:
        with self._lock:
            self._refill()
            self._rate = max(rate, 0.01)

    def _refill(self) -> None:
        now = time.monotonic()
        self._tokens = min(self._burst, self._tokens + (now - self._updated) * self._rate)
        self._updated = now

    def acquire(self) -> None:
        while True:
            with self._lock:
                self._refill()
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = (1.0 - self._tokens) / self._rate
            time.sleep(wait)


class Pacer:
    """The run's whole request budget.

    One instance paces every Airbnb request a run makes. It is deliberately
    not per-pass: the ban that follows a trip covers the homepage, the PDP
    and the calendar endpoint together, so the search and the two listing
    passes are drawing on a single counter whether the code models it that
    way or not. Since the passes run in sequence, one process-wide pacer is
    the whole implementation.
    """

    def __init__(self, rate: float, min_rate: float = 0.5, timeout_backoff: int = 5):
        self.bucket = TokenBucket(rate)
        self.min_rate = min_rate
        self.timeout_backoff = timeout_backoff
        self._lock = threading.Lock()
        self._consecutive_timeouts = 0
        self.sent = 0
        self.timeouts = 0

    def wait_turn(self) -> None:
        """Block until this caller may send a request."""
        self.bucket.acquire()
        with self._lock:
            self.sent += 1

    def note_ok(self) -> None:
        with self._lock:
            self._consecutive_timeouts = 0

    def note_rate_limited(self) -> None:
        """A 429. Always fatal — see `RateLimited`."""
        raise RateLimited(
            "Airbnb returned 429: the per-IP request budget is exhausted. "
            "Measured, this block is IP-wide and lasts on the order of an hour, "
            f"so the run stops here rather than retrying. Sent {self.sent} requests "
            f"this run at {self.bucket.rate:.2f}/s; lower config.REQUESTS_PER_SECOND."
        )

    def note_timeout(self) -> None:
        """A hung request — possibly the limiter stalling us rather than refusing.

        One timeout is ordinary. A run of them is how mild overage presented
        in testing: at 4/s no 429 ever arrived, the connections simply stopped
        answering. Halving the rate here is the cheap response to the only
        warning we get before the expensive failure.
        """
        with self._lock:
            self.timeouts += 1
            self._consecutive_timeouts += 1
            if self._consecutive_timeouts < self.timeout_backoff:
                return
            self._consecutive_timeouts = 0
            current = self.bucket.rate
            reduced = max(current / 2, self.min_rate)
        if reduced < current:
            self.bucket.set_rate(reduced)
            log.warning(
                "%d consecutive timeouts — Airbnb may be throttling rather than "
                "refusing; dropping the request rate %.2f/s -> %.2f/s",
                self.timeout_backoff,
                current,
                reduced,
            )


_pacer: Pacer | None = None
_pacer_lock = threading.Lock()


def get() -> Pacer:
    """The process-wide pacer, created on first use from `config`."""
    global _pacer
    with _pacer_lock:
        if _pacer is None:
            from anchorage_str_db import config

            _pacer = Pacer(config.REQUESTS_PER_SECOND)
        return _pacer


def reset(rate: float | None = None) -> Pacer:
    """Start a fresh budget. Called once at the top of a run, and by tests."""
    global _pacer
    from anchorage_str_db import config

    with _pacer_lock:
        _pacer = Pacer(config.REQUESTS_PER_SECOND if rate is None else rate)
        return _pacer
