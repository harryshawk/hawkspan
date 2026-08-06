export function routeAttemptPlan(hosts, retryDelaysMs) {
  const delays = [0, ...(retryDelaysMs || [])];
  return hosts.flatMap((host, routeIndex) => delays.map((delayMs, index) => ({
    host,
    cycle: index + 1,
    delay_ms: delayMs,
    route_index: routeIndex,
    is_last_route: routeIndex === hosts.length - 1,
  })));
}

export function operationAttemptFits({ remainingMs, delayMs, attemptTimeoutMs, isLastRoute }) {
  const fallbackReserveMs = isLastRoute ? 0 : attemptTimeoutMs;
  return remainingMs >= delayMs + attemptTimeoutMs + fallbackReserveMs;
}
