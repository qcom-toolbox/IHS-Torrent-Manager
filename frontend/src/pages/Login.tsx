import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { api, ApiError } from '../lib/api';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ notice: string | null }>('/auth/notice')
      .then((res) => setNotice(res.notice))
      .catch(() => setNotice(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/');
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        {notice && (
          <div className="mb-4 whitespace-pre-line rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {notice}
          </div>
        )}
        <form onSubmit={handleSubmit} className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h1 className="mb-6 text-xl font-bold text-slate-900 dark:text-slate-100">IHS Torrent Manager</h1>
          {error && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {error}
            </div>
          )}
          <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Username</label>
          <input className="input mb-4" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Password</label>
          <input className="input mb-6" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="submit" disabled={submitting} className="btn w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
