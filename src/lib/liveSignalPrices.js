export function getSignalCoins(signals) {
  return [...new Set(signals.map((signal) => signal.coin).filter(Boolean))];
}

export function mergeSignalLivePrices(signals, priceRows = []) {
  if (!signals.length || !priceRows.length) {
    return signals;
  }

  const priceMap = new Map(
    priceRows
      .filter((row) => row?.coin)
      .map((row) => [row.coin, row]),
  );

  return signals.map((signal) => {
    const live = priceMap.get(signal.coin);

    if (!live || !Number.isFinite(Number(live.livePrice))) {
      return signal;
    }

    const livePrice = Number(live.livePrice);
    const entry = Number(signal.entry || 0);
    const previousPrice = Number(signal.livePrice);
    const marketMovePercent = entry ? Number((((livePrice - entry) / entry) * 100).toFixed(2)) : null;
    const signalMovePercent = entry
      ? Number((((signal.side === "LONG" ? livePrice - entry : entry - livePrice) / entry) * 100).toFixed(2))
      : null;
    const priceDirection = Number.isFinite(previousPrice)
      ? livePrice > previousPrice
        ? "UP"
        : livePrice < previousPrice
          ? "DOWN"
          : "FLAT"
      : "FLAT";

    return {
      ...signal,
      livePrice,
      liveUpdatedAt: live.liveUpdatedAt,
      marketMovePercent,
      priceDirection,
      signalMovePercent,
    };
  });
}
