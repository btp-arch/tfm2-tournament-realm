type SupabaseLikeError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

export function formatError(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") {
    return fallback;
  }

  const candidate = error as SupabaseLikeError;
  const parts = [candidate.message, candidate.code, candidate.details, candidate.hint]
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" ") : fallback;
}

export function logError(context: string, error: unknown) {
  if (process.env.NODE_ENV !== "production") {
    console.error(context, error);
  }
}
