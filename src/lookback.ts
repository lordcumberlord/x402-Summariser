export const MAX_LOOKBACK_MINUTES = 8 * 60; // 8 hours

export function validateLookback(rawValue: unknown) {
  const numeric = Number(rawValue);

  if (!Number.isFinite(numeric)) {
    return { error: "Lookback must be provided as a number of minutes." } as const;
  }

  const minutes = Math.floor(numeric);

  if (minutes <= 0) {
    return { error: "Lookback must be at least 1 minute." } as const;
  }

  if (minutes > MAX_LOOKBACK_MINUTES) {
    return {
      error: `Lookback may not exceed ${MAX_LOOKBACK_MINUTES} minutes (8 hours).`,
    } as const;
  }

  return { minutes } as const;
}

