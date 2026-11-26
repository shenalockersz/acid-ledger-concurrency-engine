import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    race_withdrawals: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 40,
      exec: "runRaceWithdrawals",
    },
    idempotency_replay: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 2,
      exec: "runIdempotencyReplay",
      startTime: "2s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
};

export function runRaceWithdrawals() {
  const res = http.post(
    `${BASE_URL}/api/lab/race-withdrawals`,
    JSON.stringify({ concurrency: 25, initialBalance: 5000, withdrawalAmount: 1000 }),
    { headers: { "Content-Type": "application/json" } }
  );

  check(res, {
    "status is 200": (r) => r.status === 200,
    "invariant verified": (r) => r.json("invariantPassed") === true,
  });
}

export function runIdempotencyReplay() {
  const res = http.post(
    `${BASE_URL}/api/lab/deadlock-stress`,
    JSON.stringify({ pairs: 10, amount: 100 }),
    { headers: { "Content-Type": "application/json" } }
  );

  check(res, {
    "status is 200": (r) => r.status === 200,
    "zero deadlocks": (r) => r.json("deadlocks") === 0 && r.json("invariantPassed") === true,
  });
}
