import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { readImage } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import Database from '@tauri-apps/plugin-sql';
import type { HardwareProfile, ImageAsset, LocalModel, OllamaStatus, Project, PullProgress, StreamChunk, AiSlide } from '../../types/deck';
import type { Bridge, SettingsMap } from './types';

const PULL_EVENT = 'ollama://pull-progress';
const STREAM_EVENT = 'ollama://stream-chunk';
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

interface StorageInfo {
  dataDir: string;
  projectsDir: string;
  dbUrl: string;
}

interface ProjectRow {
  data: string;
}

interface SettingRow {
  key: string;
  value: string;
}

let databasePromise: Promise<Database> | null = null;

function database(): Promise<Database> {
  if (!databasePromise) {
    databasePromise = invoke<StorageInfo>('get_storage_info')
      .then((info) => Database.load(info.dbUrl))
      .catch((error: unknown) => {
        // A failed open must not be cached, or every later save would fail until a restart.
        databasePromise = null;
        throw error;
      });
  }
  return databasePromise;
}

async function clipboardImageToBlob(): Promise<Blob | null> {
  const image = await readImage();
  const { width, height } = await image.size();
  const rgba = await image.rgba();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function createTauriBridge(): Bridge {
  const appWindow = getCurrentWebviewWindow();

  return {
    kind: 'tauri',
    canLaunchOllama: true,

    getHardwareSpecs: () => invoke<HardwareProfile>('get_hardware_specs'),
    checkOllamaStatus: () => invoke<OllamaStatus>('check_ollama_status'),
    listLocalModels: () => invoke<LocalModel[]>('list_local_models'),
    launchOllama: () => invoke<void>('launch_ollama_serve'),
    openExternal: (url) => openExternal(url),

    pullModel: (model) => invoke<void>('pull_model_stream', { modelName: model }),
    cancelPull: async (model) => {
      await invoke<boolean>('cancel_model_pull', { modelName: model });
    },
    onPullProgress: (listener) => listen<PullProgress>(PULL_EVENT, (event) => listener(event.payload)),

    analyzeScript: (args) => invoke<AiSlide[] | null>('analyze_script_to_slides', { ...args }),
    analyzePin: (args) => invoke<string | null>('analyze_image_pin', { ...args }),
    cancelAnalysis: async (requestId) => {
      await invoke<boolean>('cancel_analysis', { requestId });
    },
    onStreamChunk: (listener) => listen<StreamChunk>(STREAM_EVENT, (event) => listener(event.payload)),

    async loadProjects() {
      const db = await database();
      const rows = await db.select<ProjectRow[]>('SELECT data FROM projects ORDER BY created_at ASC');
      return rows.map((row) => JSON.parse(row.data) as Project);
    },

    async saveProject(project) {
      const db = await database();
      const json = JSON.stringify(project);
      await db.execute(
        `INSERT INTO projects (id, name, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(id) DO UPDATE SET name = $2, data = $3, updated_at = $5`,
        [project.id, project.name, json, project.createdAt, project.updatedAt],
      );
      // The JSON mirror is a recovery copy, so failing to write it never fails the save.
      await invoke('write_project_snapshot', { projectId: project.id, json }).catch(() => undefined);
    },

    async deleteProject(projectId) {
      const db = await database();
      await db.execute('DELETE FROM projects WHERE id = $1', [projectId]);
      await invoke('delete_project_files', { projectId });
    },

    async loadSettings() {
      const db = await database();
      const rows = await db.select<SettingRow[]>('SELECT key, value FROM settings');
      const settings: SettingsMap = {};
      for (const row of rows) settings[row.key] = row.value;
      return settings;
    },

    async saveSetting(key, value) {
      const db = await database();
      await db.execute('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2', [key, value]);
    },

    async saveImage(projectId, blob, fileName) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return invoke<ImageAsset>('save_image_asset', bytes, {
        headers: {
          'x-project-id': projectId,
          'x-file-name': encodeURIComponent(fileName),
        },
      });
    },

    async pickImage(projectId) {
      const path = await openDialog({
        multiple: false,
        directory: false,
        title: 'Choose an image',
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
      });
      if (typeof path !== 'string') return null;
      return invoke<ImageAsset>('import_image_from_path', { projectId, path });
    },

    prepareAssets: async () => undefined,
    assetUrl: (_projectId, asset) => convertFileSrc(asset.path),
    assetBase64: (projectId, asset) => invoke<string>('read_asset_base64', { projectId, storedName: asset.storedName }),

    readClipboardImage: async () => {
      try {
        return await clipboardImageToBlob();
      } catch {
        return null;
      }
    },

    async saveExport(fileName, bytes, filter) {
      const path = await saveDialog({ defaultPath: fileName, filters: [filter] });
      if (!path) return null;
      await writeFile(path, bytes);
      return path;
    },

    setFullscreen: (enabled) => appWindow.setFullscreen(enabled),
    setWindowColor: (color) => appWindow.setBackgroundColor(color),
    showWindow: async () => {
      await appWindow.show();
      await appWindow.setFocus();
    },
    onCloseRequested: (handler) =>
      appWindow.onCloseRequested(async () => {
        await handler();
      }),
  };
}
