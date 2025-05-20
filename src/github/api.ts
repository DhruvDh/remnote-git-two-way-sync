// GitHub API helper functions for the RemNote sync plugin
import { ReactRNPlugin } from '@remnote/plugin-sdk';

interface GithubFile {
  path: string;
  sha: string;
}

interface FileResponse {
  content: string;
  sha: string;
}

export async function getFile(
  plugin: ReactRNPlugin,
  path: string
): Promise<{ ok: boolean; status: number; data?: FileResponse; message?: string }> {
  try {
    const { owner, repo, branch, token } = await getSettings(plugin);
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
        path
      )}?ref=${branch}`,
      {
        headers: {
          Authorization: `token ${token}`,
        },
      }
    );
    if (!res.ok) {
      return { ok: false, status: res.status, message: await res.text() };
    }
    const json = await res.json();
    const content = atob(json.content.replace(/\n/g, ''));
    return { ok: true, status: res.status, data: { content, sha: json.sha } };
  } catch (err: any) {
    return { ok: false, status: 0, message: err.message };
  }
}

export async function createOrUpdateFile(
  plugin: ReactRNPlugin,
  path: string,
  content: string,
  sha?: string
): Promise<{ ok: boolean; status: number; message?: string; sha?: string }> {
  try {
    const { owner, repo, branch, token } = await getSettings(plugin);
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      path
    )}`;
    const body: any = {
      message: `Update ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
    };
    if (sha) {
      body.sha = sha;
    }
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: await res.text() };
    }
    const json = await res.json();
    return { ok: true, status: res.status, sha: json.content.sha };
  } catch (err: any) {
    return { ok: false, status: 0, message: err.message };
  }
}

export async function deleteFile(
  plugin: ReactRNPlugin,
  path: string,
  sha: string
): Promise<{ ok: boolean; status: number; message?: string }> {
  try {
    const { owner, repo, branch, token } = await getSettings(plugin);
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      path
    )}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: `Delete ${path}`, sha, branch }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: await res.text() };
    }
    return { ok: true, status: res.status };
  } catch (err: any) {
    return { ok: false, status: 0, message: err.message };
  }
}

export async function listFiles(
  plugin: ReactRNPlugin,
  dir: string
): Promise<{ ok: boolean; status: number; files?: GithubFile[]; message?: string }> {
  try {
    const { owner, repo, branch, token } = await getSettings(plugin);
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      dir
    )}?ref=${branch}`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${token}` },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: await res.text() };
    }
    const json = await res.json();
    const files: GithubFile[] = Array.isArray(json)
      ? json.map((f: any) => ({ path: f.path, sha: f.sha }))
      : [];
    return { ok: true, status: res.status, files };
  } catch (err: any) {
    return { ok: false, status: 0, message: err.message };
  }
}

export async function createOrUpdateBinaryFile(
  plugin: ReactRNPlugin,
  path: string,
  base64Content: string,
  sha?: string
): Promise<{ ok: boolean; status: number; message?: string; sha?: string }> {
  try {
    const { owner, repo, branch, token } = await getSettings(plugin);
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      path
    )}`;
    const body: any = {
      message: `Update ${path}`,
      content: base64Content,
      branch,
    };
    if (sha) {
      body.sha = sha;
    }
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: await res.text() };
    }
    const json = await res.json();
    return { ok: true, status: res.status, sha: json.content.sha };
  } catch (err: any) {
    return { ok: false, status: 0, message: err.message };
  }
}

export async function getBinaryFile(
  plugin: ReactRNPlugin,
  path: string
): Promise<{ ok: boolean; status: number; data?: { content: string; sha: string }; message?: string }> {
  try {
    const { owner, repo, branch, token } = await getSettings(plugin);
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
        path
      )}?ref=${branch}`,
      {
        headers: {
          Authorization: `token ${token}`,
        },
      }
    );
    if (!res.ok) {
      return { ok: false, status: res.status, message: await res.text() };
    }
    const json = await res.json();
    const content = json.content.replace(/\n/g, '');
    return { ok: true, status: res.status, data: { content, sha: json.sha } };
  } catch (err: any) {
    return { ok: false, status: 0, message: err.message };
  }
}

async function getSettings(plugin: ReactRNPlugin) {
  const repoString = await plugin.settings.getSetting<string>('github-repo');
  const token = await plugin.settings.getSetting<string>('github-token');
  const branch = (await plugin.settings.getSetting<string>('github-branch')) || 'main';
  const [owner, repo] = repoString?.split('/') ?? [];
  if (!owner || !repo || !token) {
    throw new Error('Missing GitHub configuration');
  }
  return { owner, repo, branch, token };
}
