export function isBackendUnreachable(error) {
  let cause = error;
  while (cause) {
    if (cause.code === 'ECONNREFUSED' || cause.code === 'ENOTFOUND' || cause.code === 'ECONNRESET') return true;
    if (Array.isArray(cause.errors) && cause.errors.some((item) => item?.code === 'ECONNREFUSED')) return true;
    cause = cause.cause;
  }
  return false;
}
