// Load generator: unique rack/candidate per synthetic booking (still valid after
// duplicate-active rules were relaxed — the server no longer rejects reused actives).
import crypto from "node:crypto";

function envStr(name, fallback) {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parsePhones(raw) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function login({ baseUrl, phone, password, timeoutMs }) {
  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/auth/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, password }),
    },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`login_failed phone=${phone} status=${res.status} body=${text}`);
  }

  const json = await res.json();
  if (!json?.accessToken) throw new Error(`login_missing_token phone=${phone}`);
  return json.accessToken;
}

function makeMutations({
  completed,
  mutationsPerRequest,
  vuId,
  bookingIndexStart,
}) {
  const bookingsPerRequest = completed
    ? Math.floor(mutationsPerRequest / 2)
    : mutationsPerRequest;

  const mutations = [];

  for (let i = 0; i < bookingsPerRequest; i++) {
    const idx = bookingIndexStart + i;
    const bookingId = crypto.randomUUID();
    const rackId = `R-${vuId}-${idx}`;
    const candidateId = `C-${vuId}-${idx}`;

    const startedAt = new Date(Date.now() - (idx % 3600) * 1000).toISOString();
    const endedAt = new Date(Date.now() - (idx % 1800) * 1000).toISOString();

    mutations.push({
      type: "booking_start",
      bookingId,
      rackId,
      candidateId,
      startedAt,
    });

    if (completed) {
      mutations.push({
        type: "booking_finish",
        bookingId,
        endedAt,
      });
    }
  }

  return mutations;
}

async function pushBatch({
  baseUrl,
  accessToken,
  deviceId,
  mutations,
  timeoutMs,
}) {
  const res = await fetchWithTimeout(
    `${baseUrl}/sync/push`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, mutations }),
    },
    timeoutMs,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`push_failed status=${res.status} body=${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`push_bad_json body=${text.slice(0, 300)}`);
  }

  const results = Array.isArray(json?.results) ? json.results : [];
  let ok = 0;
  let err = 0;
  for (const r of results) {
    if (r?.ok === true) ok += 1;
    else err += 1;
  }

  return { ok, err, resultCount: results.length };
}

async function run() {
  const baseUrl = envStr("BASE_URL", "http://127.0.0.1:3040");
  const password = envStr("PASSWORD", "password");
  const phones = parsePhones(envStr("PHONES", ""));

  const operators = envInt("OPERATORS", 25);
  const bookingsPerOperator = envInt("BOOKINGS_PER_OPERATOR", 2500);
  const mutationsPerRequest = Math.min(500, envInt("MUTATIONS_PER_REQUEST", 200));
  const completed = envStr("COMPLETED", "true").toLowerCase() !== "false";
  const requestTimeoutMs = envInt("REQUEST_TIMEOUT_MS", 30000);

  if (phones.length === 0) {
    console.error(
      "Missing PHONES env var. Provide comma-separated operator phones.\n" +
        'Example: $env:PHONES="7398296725,..."',
    );
    process.exitCode = 2;
    return;
  }

  const mutationsPerBooking = completed ? 2 : 1;
  const totalMutationsPerOperator = bookingsPerOperator * mutationsPerBooking;
  const requestsPerOperator = Math.ceil(totalMutationsPerOperator / mutationsPerRequest);

  console.log(
    JSON.stringify(
      {
        baseUrl,
        operators,
        bookingsPerOperator,
        completed,
        mutationsPerRequest,
        totalMutationsPerOperator,
        requestsPerOperator,
      },
      null,
      2,
    ),
  );

  const latenciesMs = [];
  let totalOk = 0;
  let totalErr = 0;
  let totalRequests = 0;
  const progressEvery = Math.max(1, envInt("PROGRESS_EVERY_REQUESTS", 25));
  let lastProgressAt = Date.now();
  let lastAnyActivityAt = Date.now();

  const startedAt = Date.now();

  const heartbeatEveryMs = envInt("HEARTBEAT_EVERY_MS", 5000);
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const elapsed = now - startedAt;
    const rpsNow = elapsed > 0 ? totalRequests / (elapsed / 1000) : 0;
    const mpsNow = elapsed > 0 ? (totalOk + totalErr) / (elapsed / 1000) : 0;
    const idleForMs = now - lastAnyActivityAt;
    console.log(
      `[heartbeat] elapsedMs=${elapsed} requests=${totalRequests} ok=${totalOk} err=${totalErr} ` +
        `rps=${rpsNow.toFixed(2)} mps=${mpsNow.toFixed(2)} idleForMs=${idleForMs}`,
    );
  }, heartbeatEveryMs);
  heartbeat.unref?.();

  const workers = Array.from({ length: operators }).map(async (_x, vuId) => {
    const phone = phones[vuId % phones.length];
    const deviceId = `load-${phone}`;

    console.log(`[vu ${vuId}] login start phone=${phone}`);
    const accessToken = await login({ baseUrl, phone, password, timeoutMs: requestTimeoutMs });
    console.log(`[vu ${vuId}] login ok`);
    lastAnyActivityAt = Date.now();

    let mutationIdx = 0;
    for (let r = 0; r < requestsPerOperator; r++) {
      const t0 = Date.now();
      const mutations = makeMutations({
        completed,
        mutationsPerRequest,
        vuId,
        bookingIndexStart: mutationIdx,
      });
      mutationIdx += completed
        ? Math.floor(mutationsPerRequest / 2)
        : mutationsPerRequest;

      console.log(`[vu ${vuId}] push start batch=${r + 1}/${requestsPerOperator} mutations=${mutations.length}`);
      let out;
      try {
        out = await pushBatch({
          baseUrl,
          accessToken,
          deviceId,
          mutations,
          timeoutMs: requestTimeoutMs,
        });
      } catch (e) {
        console.error(
          `[vu ${vuId}] push failed batch=${r + 1}/${requestsPerOperator} ` +
            `err=${e?.message ?? e}`,
        );
        throw e;
      }
      const dt = Date.now() - t0;

      latenciesMs.push(dt);
      totalOk += out.ok;
      totalErr += out.err;
      totalRequests += 1;
      lastAnyActivityAt = Date.now();

      if (totalRequests % progressEvery === 0) {
        const now = Date.now();
        const elapsed = now - startedAt;
        const rpsNow = elapsed > 0 ? totalRequests / (elapsed / 1000) : 0;
        const mpsNow = elapsed > 0 ? (totalOk + totalErr) / (elapsed / 1000) : 0;
        const sinceLast = now - lastProgressAt;
        lastProgressAt = now;
        console.log(
          `[progress] requests=${totalRequests} ok=${totalOk} err=${totalErr} ` +
            `rps=${rpsNow.toFixed(2)} mps=${mpsNow.toFixed(2)} lastLatencyMs=${dt} ` +
            `(+${sinceLast}ms)`,
        );
      }
    }
  });

  try {
    await Promise.all(workers);
  } catch (e) {
    console.error("Load test failed:", e?.message ?? e);
    process.exitCode = 1;
    clearInterval(heartbeat);
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  const rps = totalRequests / (elapsedMs / 1000);
  const mps = (totalOk + totalErr) / (elapsedMs / 1000);

  clearInterval(heartbeat);
  console.log("\n=== SUMMARY ===");
  console.log(
    JSON.stringify(
      {
        elapsedMs,
        totalRequests,
        requestsPerSecond: Number(rps.toFixed(2)),
        totalMutations: totalOk + totalErr,
        mutationsPerSecond: Number(mps.toFixed(2)),
        ok: totalOk,
        err: totalErr,
        latencyMs: {
          p50: percentile(latenciesMs, 50),
          p90: percentile(latenciesMs, 90),
          p95: percentile(latenciesMs, 95),
          p99: percentile(latenciesMs, 99),
          max: Math.max(...latenciesMs),
        },
      },
      null,
      2,
    ),
  );
}

await run();

