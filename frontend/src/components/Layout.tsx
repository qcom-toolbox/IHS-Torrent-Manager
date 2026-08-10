import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTheme } from '../lib/ThemeContext';

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm font-medium ${
    isActive
      ? 'bg-blue-600 text-white'
      : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800'
  }`;

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-shrink-0 flex-col border-r border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 px-2 text-lg font-bold text-slate-900 dark:text-white">Torrent Manager</div>
        <nav className="flex flex-1 flex-col gap-1">
          <NavLink to="/" end className={navItemClass}>Dashboard</NavLink>
          <NavLink to="/torrents" className={navItemClass}>My Torrents</NavLink>
          <NavLink to="/upload" className={navItemClass}>Upload Torrent</NavLink>
          <NavLink to="/completed" className={navItemClass}>Completed</NavLink>
          {user?.isAdmin && (
            <>
              <div className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Admin</div>
              <NavLink to="/users" className={navItemClass}>Users</NavLink>
              <NavLink to="/all-torrents" className={navItemClass}>All Torrents</NavLink>
            </>
          )}
          <NavLink to="/settings" className={navItemClass}>Settings</NavLink>
        </nav>
        <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-sm text-slate-500 dark:text-slate-400">{user?.username}</span>
            {user?.isAdmin && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-700 dark:bg-blue-900 dark:text-blue-200">
                Admin
              </span>
            )}
          </div>
          <button
            onClick={toggle}
            className="mb-2 w-full rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button
            onClick={handleLogout}
            className="w-full rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-auto p-6">{children}</main>
    </div>
  );
}
