import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider } from "./context/SessionContext";
import { useSession } from "./context/useSession";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Market from "./pages/Market";
import News from "./pages/News";
import Signup from "./pages/Signup";

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
          <Route element={<News />} path="/news" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
