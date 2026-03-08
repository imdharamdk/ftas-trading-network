export default function DistributionList({ data, emptyLabel = "No data yet", tone = "accent" }) {
  const max = Math.max(...data.map((item) => item.value), 1);

  if (!data.length) {
    return <div className="empty-state">{emptyLabel}</div>;
  }

  return (
    <div className="distribution-list">
      {data.map((item) => (
        <div className="distribution-row" key={item.label}>
          <div className="distribution-head">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
          <div className="distribution-track">
            <span
              className={`distribution-fill distribution-fill-${tone}`}
              style={{ width: `${Math.max((item.value / max) * 100, 8)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
