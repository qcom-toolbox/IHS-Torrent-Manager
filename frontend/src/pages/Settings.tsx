import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import DiskSpaceWidget from '../components/DiskSpaceWidget';

export default function Settings() {
  const { user } = useAuth();
  const { notify } = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [thresholds, setThresholds] = useState<{ disk_warning_percent_free: string; disk_critical_percent_free: string; disk_block_percent_free: string } | null>(null);
  const [portalPassword, setPortalPassword] = useState('');
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [savingPortalPassword, setSavingPortalPassword] = useState(false);

  useEffect(() => {
    if (user?.isAdmin) {
      api.get<{ settings: Record<string, string> }>('/admin/settings').then((res) => {
        setThresholds({
          disk_warning_percent_free: res.settings.disk_warning_percent_free ?? '20',
          disk_critical_percent_free: res.settings.disk_critical_percent_free ?? '10',
          disk_block_percent_free: res.settings.disk_block_percent_free ?? '5',
        });
      });
    }
  }, [user?.isAdmin]);

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setSavingPassword(true);
    try {
      await api.put('/auth/password', { currentPassword, newPassword });
      notify('Password updated', 'success');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Failed to update password', 'error');
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleThresholdsSave(e: React.FormEvent) {
    e.preventDefault();
    if (!thresholds) return;
    setSavingThresholds(true);
    try {
      await api.put('/admin/settings', thresholds);
      notify('Storage thresholds updated', 'success');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Failed to update thresholds', 'error');
    } finally {
      setSavingThresholds(false);
    }
  }

  async function handlePortalPasswordSave(e: React.FormEvent) {
    e.preventDefault();
    setSavingPortalPassword(true);
    try {
      await api.put('/admin/portal-password', { password: portalPassword });
      notify('Download portal password updated', 'success');
      setPortalPassword('');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Failed to update portal password', 'error');
    } finally {
      setSavingPortalPassword(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Settings</h1>

      <div className="card max-w-lg">
        <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">Account</h2>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          Signed in as <span className="font-medium">{user?.username}</span> {user?.isAdmin && '(Administrator)'}
        </p>
        <form onSubmit={handlePasswordChange}>
          <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Current password</label>
          <input type="password" className="input mb-3" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">New password</label>
          <input type="password" className="input mb-4" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
          <button type="submit" disabled={savingPassword} className="btn">Change password</button>
        </form>
      </div>

      <div className="max-w-lg">
        <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Storage</h2>
        <DiskSpaceWidget detailed />
      </div>

      {user?.isAdmin && thresholds && (
        <>
          <div className="card max-w-lg">
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">Storage thresholds</h2>
            <form onSubmit={handleThresholdsSave} className="flex flex-col gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Warning below (% free)</label>
                <input type="number" min={0} max={100} className="input" value={thresholds.disk_warning_percent_free}
                  onChange={(e) => setThresholds({ ...thresholds, disk_warning_percent_free: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Critical below (% free)</label>
                <input type="number" min={0} max={100} className="input" value={thresholds.disk_critical_percent_free}
                  onChange={(e) => setThresholds({ ...thresholds, disk_critical_percent_free: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Block new downloads below (% free)</label>
                <input type="number" min={0} max={100} className="input" value={thresholds.disk_block_percent_free}
                  onChange={(e) => setThresholds({ ...thresholds, disk_block_percent_free: e.target.value })} />
              </div>
              <button type="submit" disabled={savingThresholds} className="btn mt-2">Save thresholds</button>
            </form>
          </div>

          <div className="card max-w-lg">
            <h2 className="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100">Download portal password</h2>
            <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
              This is the single shared password used to access the separate, simplified download portal.
            </p>
            <form onSubmit={handlePortalPasswordSave}>
              <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">New portal password</label>
              <input type="password" className="input mb-4" value={portalPassword} onChange={(e) => setPortalPassword(e.target.value)} required minLength={8} />
              <button type="submit" disabled={savingPortalPassword} className="btn">Update portal password</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
