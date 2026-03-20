import ErrorBoundary from "./components/ErrorBoundary";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider } from "./context/SessionContext";
import { useSession } from "./context/useSession";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Market from "./pages/Market";
import Crypto from "./pages/Crypto";
import News from "./pages/News";
import Signup from "./pages/Signup";
import Stocks from "./pages/Stocks";
import PostGenerator from "./pages/PostGenerator";
import Analytics from "./pages/Analytics";
import Settings from "./pages/Settings";

function SessionGate({ children, guestOnly = false }) {
  const { loading, user } = useSession();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <span className="eyebrow">Fintech Automated Solutions</span>
          <h1>Loading signal desk</h1>
        </div>
      </div>
    );
  }

  if (guestOnly && user) {
    return <Navigate replace to="/dashboard" />;
  }

  if (!guestOnly && !user) {
    return <Navigate replace to="/" />;
  }

  return children;
}

export default function App() {
  return (
    <ErrorBoundary>
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route
            element={
              <SessionGate guestOnly>
                <Login />
              </SessionGate>
            }
            path="/"
          />
          <Route
            element={
              <SessionGate guestOnly>
                <Signup />
              </SessionGate>
            }
            path="/signup"
          />
          <Route
            element={
              <SessionGate>
                <Dashboard />
              </SessionGate>
            }
            path="/dashboard"
          />
          <Route
            element={
              <SessionGate>
                <Market />
              </SessionGate>
            }
            path="/market"
          />
          <Route
            element={
              <SessionGate>
                <Crypto />
              </SessionGate>
            }
            path="/crypto"
          />
          <Route
            element={
              <SessionGate>
                <Stocks />
              </SessionGate>
            }
            path="/stocks"
          />
          <Route element={<News />} path="/news" />
          <Route element={<SessionGate><PostGenerator /></SessionGate>} path="/post-generator" />
          <Route element={<SessionGate><Analytics /></SessionGate>}     path="/analytics" />
          <Route element={<SessionGate><Settings /></SessionGate>}      path="/settings" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
    </ErrorBoundary>
  );
}
