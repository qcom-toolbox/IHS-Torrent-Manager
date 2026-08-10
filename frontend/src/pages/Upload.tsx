import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/ToastContext';

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { notify } = useToast();
  const navigate = useNavigate();

  function pickFile(f: File | null) {
    setError(null);
    if (f && !f.name.toLowerCase().endsWith('.torrent')) {
      setError('Only .torrent files are accepted');
      return;
    }
    setFile(f);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Please choose a .torrent file');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('torrent', file);
      if (category) form.append('category', category);
      await api.postForm('/torrents/upload', form);
      notify('Torrent added successfully', 'success');
      navigate('/torrents');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Upload Torrent</h1>
      <form onSubmit={handleSubmit} className="card max-w-lg">
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pickFile(e.dataTransfer.files[0] ?? null);
          }}
          onClick={() => inputRef.current?.click()}
          className={`mb-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
            dragOver ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-slate-300 dark:border-slate-700'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".torrent"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <span className="font-medium text-slate-700 dark:text-slate-200">{file.name}</span>
          ) : (
            <span className="text-sm text-slate-400">Click to choose or drag a .torrent file here</span>
          )}
        </div>
        <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Category (optional)</label>
        <input className="input mb-6" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. movies" />
        <button type="submit" disabled={submitting} className="btn w-full">
          {submitting ? 'Uploading…' : 'Add Torrent'}
        </button>
      </form>
    </div>
  );
}
