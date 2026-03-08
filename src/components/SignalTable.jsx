function formatPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";

  // Use universal locale-independent formatting to avoid
  // comma/dot separator issues across different environments
  if (Math.abs(amount) >= 10000) {
    // e.g. 65,234.12
    return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (Math.abs(amount) >= 1000) {
    // e.g. 1,234.5678
    return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (Math.abs(amount) >= 1) {
    return amount.toFixed(4);
  }
  // Small alts like SHIBUSDT
  if (Math.abs(amount) >= 0.0001) {
    return amount.toFixed(6);
  }
  return amount.toFixed(8);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function formatSignedPercent(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "";
  }

  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}%`;
}

function sideClass(side) {
  return side === "LONG" ? "pill-success" : "pill-danger";
}

function statusClass(status, result) {
  if (status === "ACTIVE") {
    return "pill-warning";
  }

  if (result === "SL_HIT") {
    return "pill-danger";
  }

  return "pill-success";
}

export default function SignalTable({ compact = false, emptyLabel, signals }) {
  return (
    <div className="table-card">
      <div className="table-wrap">
        <table className={`signal-table${compact ? " signal-table-compact" : ""}`}>
          <thead>
            <tr>
              <th>Coin</th>
              <th>Side</th>
              <th>TF</th>
              <th>Entry</th>
              <th>Live</th>
              <th>SL</th>
              <th>TP1</th>
              <th>TP2</th>
              <th>TP3</th>
              <th>Confidence</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {signals.length ? (
              signals.map((signal) => (
                <tr key={signal.id}>
                  <td>
                    <strong>{signal.coin}</strong>
                  </td>
                  <td>
                    <span className={`pill ${sideClass(signal.side)}`}>{signal.side}</span>
                  </td>
                  <td>{signal.timeframe}</td>
                  <td>{formatPrice(signal.entry)}</td>
                  <td>
                    <strong>{formatPrice(signal.livePrice ?? signal.closePrice)}</strong>
                    {Number.isFinite(Number(signal.signalMovePercent)) ? (
                      <div>
                        <span className={`pill ${Number(signal.signalMovePercent) >= 0 ? "pill-success" : "pill-danger"}`}>
                          {formatSignedPercent(signal.signalMovePercent)}
                        </span>
                      </div>
                    ) : null}
                  </td>
                  <td>{formatPrice(signal.stopLoss)}</td>
                  <td>{formatPrice(signal.tp1)}</td>
                  <td>{formatPrice(signal.tp2)}</td>
                  <td>{formatPrice(signal.tp3)}</td>
                  <td>{signal.confidence}%</td>
                  <td>
                    <span className={`pill ${statusClass(signal.status, signal.result)}`}>
                      {signal.result || signal.status}
                    </span>
                  </td>
                  <td>{formatDate(signal.createdAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="empty-row" colSpan="12">
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
