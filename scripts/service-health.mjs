export function periodicServiceHealthy(service) {
  return service.loaded === true &&
    (Number.isFinite(service.pid) || service.last_status === 0);
}
