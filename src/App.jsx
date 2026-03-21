import ErrorBoundary from "./components/ErrorBoundary";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider } from "./context/SessionContext";
import { useSession } from "./context/useSession";
import { lazy, Suspense } from "react";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";

// Lazy load heavy pages — browser downloads them only when first visited
const Dashboard    = lazy(() => import("./pages/Dashboard"));
const Market       = lazy(() => import("./pages/Market"));
const Crypto       = lazy(() => import("./pages/Crypto"));
const News         = lazy(() => import("./pages/News"));
const Stocks       = lazy(() => import("./pages/Stocks"));
const PostGenerator= lazy(() => import("./pages/PostGenerator"));
const Analytics    = lazy(() => import("./pages/Analytics"));
const Settings     = lazy(() => import("./pages/Settings"));
const Community    = lazy(() => import("./pages/Community"));

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
        <Suspense fallback={
          <div className="loading-screen">
            <div className="loading-card">
              <span className="eyebrow">Fintech Automated Solutions</span>
              <h1>Loading...</h1>
            </div>
          </div>
        }>
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
          <Route element={<Terms />} path="/terms" />
          <Route element={<Privacy />} path="/privacy" />
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
          <Route element={<SessionGate><Community /></SessionGate>}     path="/community" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </SessionProvider>
    </ErrorBoundary>
  );
}
