const PASSWORD_RESET_PATH = "/auth/update-password";

type RecoveryLocation = Pick<Location, "origin" | "pathname" | "search" | "hash">;

function hasRecoveryType(paramsText: string) {
  if (!paramsText) {
    return false;
  }

  const params = new URLSearchParams(paramsText.startsWith("#") ? paramsText.slice(1) : paramsText);
  return params.get("type") === "recovery";
}

export function getPasswordResetRedirectUrl() {
  if (typeof window === "undefined") {
    return PASSWORD_RESET_PATH;
  }

  return new URL(PASSWORD_RESET_PATH, window.location.origin).toString();
}

export function getRecoveryRedirectDestination(location: RecoveryLocation) {
  if (location.pathname === PASSWORD_RESET_PATH) {
    return null;
  }

  if (!hasRecoveryType(location.search) && !hasRecoveryType(location.hash)) {
    return null;
  }

  const destination = new URL(PASSWORD_RESET_PATH, location.origin);
  destination.search = location.search;
  destination.hash = location.hash;

  return destination.toString();
}

export function redirectRecoveryToPasswordUpdateIfNeeded() {
  if (typeof window === "undefined") {
    return false;
  }

  const destination = getRecoveryRedirectDestination(window.location);

  if (!destination) {
    return false;
  }

  window.location.replace(destination);
  return true;
}
