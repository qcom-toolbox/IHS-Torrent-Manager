import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import ConfirmDialog, { ConfirmOptions } from '../components/ConfirmDialog';
import { formatDate } from '../lib/format';
import type { User } from '../types';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Users() {
  const { user: currentUser } = useAuth();
  const { notify } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [modal, setModal] = useState<'create' | { password: User } | null>(null);
  const [confirm, setConfirm] = useState<{ options: ConfirmOptions; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ users: User[] }>('/users');
    setUsers(res.users);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/users', {
        username: form.get('username'),
        password: form.get('password'),
        isAdmin: form.get('isAdmin') === 'on',
      });
      notify('User created', 'success');
      setModal(null);
      load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Failed to create user', 'error');
    }
  }

  async function handlePasswordChange(e: React.FormEvent<HTMLFormElement>, user: User) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.put(`/users/${user.id}/password`, { password: form.get('password') });
      notify(`Password changed for ${user.username}`, 'success');
      setModal(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Failed to change password', 'error');
    }
  }

  async function toggleAdmin(user: User) {
    try {
      await api.put(`/users/${user.id}/admin`, { isAdmin: !user.isAdmin });
      notify(`${user.username} is now ${!user.isAdmin ? 'an admin' : 'a normal user'}`, 'success');
      load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Failed to update admin status', 'error');
    }
  }

  function confirmDelete(user: User) {
    setConfirm({
      options: { title: 'Delete user', message: `Delete "${user.username}"? Their torrents will be reassigned to you; downloaded data is kept.`, confirmLabel: 'Delete', danger: true },
      run: async () => {
        try {
          await api.del(`/users/${user.id}`);
          notify(`Deleted ${user.username}`, 'success');
          load();
        } catch (err) {
          notify(err instanceof ApiError ? err.message : 'Failed to delete user', 'error');
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Users</h1>
        <button className="btn" onClick={() => setModal('create')}>Create user</button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
          <thead className="bg-slate-50 dark:bg-slate-900">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Admin</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">{u.username}</td>
                <td className="px-4 py-3">{u.isAdmin ? 'Yes' : 'No'}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatDate(u.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <button className="btn-xs" onClick={() => setModal({ password: u })}>Change password</button>
                    <button className="btn-xs" onClick={() => toggleAdmin(u)}>
                      {u.isAdmin ? 'Demote' : 'Promote'}
                    </button>
                    {u.id !== currentUser?.id && (
                      <button className="btn-xs btn-xs-danger" onClick={() => confirmDelete(u)}>Delete</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal === 'create' && (
        <Modal title="Create user" onClose={() => setModal(null)}>
          <form onSubmit={handleCreate}>
            <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Username</label>
            <input name="username" className="input mb-3" required minLength={3} maxLength={32} />
            <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Password</label>
            <input name="password" type="password" className="input mb-3" required minLength={8} />
            <label className="mb-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" name="isAdmin" /> Administrator
            </label>
            <button type="submit" className="btn w-full">Create</button>
          </form>
        </Modal>
      )}

      {modal && typeof modal === 'object' && (
        <Modal title={`Change password: ${modal.password.username}`} onClose={() => setModal(null)}>
          <form onSubmit={(e) => handlePasswordChange(e, modal.password)}>
            <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">New password</label>
            <input name="password" type="password" className="input mb-4" required minLength={8} />
            <button type="submit" className="btn w-full">Update password</button>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        options={confirm?.options ?? null}
        onConfirm={() => { const c = confirm; setConfirm(null); c?.run(); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
