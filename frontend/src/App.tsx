import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { ThemeProvider } from './lib/ThemeContext';
import { ToastProvider } from './lib/ToastContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import MyTorrents from './pages/MyTorrents';
import Upload from './pages/Upload';
import Completed from './pages/Completed';
import Users from './pages/Users';
import AllTorrents from './pages/AllTorrents';
import Settings from './pages/Settings';
import TorrentDetails from './pages/TorrentDetails';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center text-slate-400">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function LoginRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
            <Route path="/torrents" element={<RequireAuth><MyTorrents /></RequireAuth>} />
            <Route path="/torrents/:id" element={<RequireAuth><TorrentDetails /></RequireAuth>} />
            <Route path="/upload" element={<RequireAuth><Upload /></RequireAuth>} />
            <Route path="/completed" element={<RequireAuth><Completed /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
            <Route
              path="/users"
              element={
                <RequireAuth>
                  <RequireAdmin><Users /></RequireAdmin>
                </RequireAuth>
              }
            />
            <Route
              path="/all-torrents"
              element={
                <RequireAuth>
                  <RequireAdmin><AllTorrents /></RequireAdmin>
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
