import { Component } from "react";

/**
 * ErrorBoundary — catches unhandled React errors and shows a fallback UI
 * instead of a blank white screen.
 *
 * Usage in App.jsx:
 *   <ErrorBoundary>
 *     <Router>...</Router>
 *   </ErrorBoundary>
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary] Unhandled render error:", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f172a",
        color: "#e2e8f0",
        fontFamily: "system-ui, sans-serif",
        padding: "24px",
      }}>
        <div style={{
          maxWidth: 480,
          textAlign: "center",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          padding: "40px 32px",
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 700 }}>
            Something went wrong
          </h2>
          <p style={{ color: "#94a3b8", fontSize: 14, margin: "0 0 24px", lineHeight: 1.6 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            style={{
              background: "rgba(99,102,241,0.2)",
              color: "#818cf8",
              border: "1px solid rgba(99,102,241,0.4)",
              borderRadius: 8,
              padding: "10px 24px",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
